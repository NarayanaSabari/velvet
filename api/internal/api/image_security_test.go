package api_test

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/imageupload"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestImageDeleteRechecksRoleAfterConcurrentDemotion(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Delete race")
	out := imageUpload(t, f, "/api/v1/w/lab/issues/"+issue.Key+"/images", "proof")
	// Hold the workspace mutation lock while a request using previously valid
	// credentials waits. The current role must be checked after this lock.
	tx, err := f.Pool.Begin(t.Context())
	require.NoError(t, err)
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(t.Context(), `SELECT pg_advisory_xact_lock(hashtextextended('image-workspace:' || $1::text,0))`, f.WorkspaceID)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() { done <- f.Store.DeleteImage(t.Context(), f.WorkspaceID, out.ID, f.User.ID) }()
	require.Eventually(t, func() bool {
		var blocked bool
		err := f.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%')`).Scan(&blocked)
		return err == nil && blocked
	}, 5*time.Second, 10*time.Millisecond)
	_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(t.Context()))
	require.ErrorIs(t, <-done, store.ErrForbidden)
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment WHERE id=$1`, out.ID).Scan(&n))
	require.Equal(t, 1, n)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM activity WHERE verb='deleted_image'`).Scan(&n))
	require.Zero(t, n)
}

func TestImageConcurrentGrantConsumeExactlyOnce(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Consume race")
	grant := imagePrepare(t, f, "/api/v1/w/lab/issues/"+issue.Key+"/images", f.AgentToken("race"))
	img, err := imageupload.Sanitize(imagePNG(t))
	require.NoError(t, err)
	start := make(chan struct{})
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		go func() {
			<-start
			_, err := f.Store.ConsumeImageUpload(t.Context(), "lab", mustGrantID(t, grant.UploadURL), grant.UploadToken, img)
			results <- err
		}()
	}
	close(start)
	successes := 0
	for i := 0; i < 8; i++ {
		err := <-results
		if err == nil {
			successes++
		} else {
			require.ErrorIs(t, err, store.ErrUploadCredential)
		}
	}
	require.Equal(t, 1, successes)
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Equal(t, 1, n)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM activity WHERE verb='attached_image'`).Scan(&n))
	require.Equal(t, 1, n)
}

func mustGrantID(t *testing.T, url string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(url[strings.LastIndex(url, "/")+1:])
	require.NoError(t, err)
	return id
}

func TestImageGrantOrganisationCapAndTenMinuteExpiry(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Organisation cap")
	var first store.ImageInput
	for user := 0; user < 6; user++ {
		actor, err := f.Store.UpsertUserByEmail(t.Context(), fmt.Sprintf("upload-%d@example.com", user))
		require.NoError(t, err)
		_, err = f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, actor.ID)
		require.NoError(t, err)
		token, err := f.Store.CreateAPIToken(t.Context(), actor.ID, "cap")
		require.NoError(t, err)
		var tokenID uuid.UUID
		require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT id FROM api_token WHERE token_hash=$1`, store.HashToken(token)).Scan(&tokenID))
		in := store.ImageInput{WorkspaceID: f.WorkspaceID, ActorID: actor.ID, TargetType: "issue", TargetID: issue.ID, Filename: "a.png", Caption: "proof", Source: "agent", APITokenID: &tokenID}
		if user == 0 {
			first = in
		}
		if user == 5 {
			_, err = f.Store.PrepareImageUpload(t.Context(), in)
			require.ErrorIs(t, err, store.ErrRateLimited)
			break
		}
		for i := 0; i < 20; i++ {
			before := time.Now()
			grant, err := f.Store.PrepareImageUpload(t.Context(), in)
			require.NoError(t, err)
			require.WithinDuration(t, before.Add(10*time.Minute), grant.ExpiresAt, 2*time.Second)
		}
	}
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_upload_grant`).Scan(&n))
	require.Equal(t, 100, n)
	_, err := f.Store.PrepareImageUpload(t.Context(), first)
	require.ErrorIs(t, err, store.ErrRateLimited)
}

func TestImageRevokedMembershipAndTokenCannotRead(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Read revocation")
	target := "/api/v1/w/lab/issues/" + issue.Key + "/images"
	out := imageUpload(t, f, target, "proof")
	token := f.AgentToken("read")
	require.Equal(t, 200, f.DoAsAgent(http.MethodGet, out.ContentURL, token, nil).Code)
	_, err := f.Pool.Exec(t.Context(), `DELETE FROM api_token WHERE token_hash=$1`, store.HashToken(token))
	require.NoError(t, err)
	require.Equal(t, 401, f.DoAsAgent(http.MethodGet, out.ContentURL, token, nil).Code)
	_, err = f.Pool.Exec(t.Context(), `DELETE FROM membership WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	for _, url := range []string{target, out.ContentURL, out.DownloadURL} {
		require.Equal(t, 404, f.Do(http.MethodGet, url, nil).Code)
	}
}

func TestImageMissingAndDuplicatedGrantHeadersRejected(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Credential shape")
	g := imagePrepare(t, f, "/api/v1/w/lab/issues/"+issue.Key+"/images", f.AgentToken("headers"))
	for _, kind := range []string{"missing", "duplicated", "oversized"} {
		r := imageRequest(t, g.UploadURL, imagePNG(t), nil)
		switch kind {
		case "duplicated":
			r.Header.Add("X-Velvet-Upload-Token", g.UploadToken)
			r.Header.Add("X-Velvet-Upload-Token", g.UploadToken)
		case "oversized":
			r.Header.Set("X-Velvet-Upload-Token", strings.Repeat("x", 257))
		}
		rec := imageServe(f, r)
		// A request with no custom credential is stopped by the browser CSRF
		// boundary before reaching the credential handler.
		if kind == "missing" {
			require.Equal(t, 403, rec.Code)
		} else {
			require.Equal(t, 401, rec.Code)
		}
	}
	require.Equal(t, 201, imageConsume(t, f, g).Code)
}

func TestImageCountCapsSerializeAndDuplicateRetriesRemainFree(t *testing.T) {
	for _, scope := range []string{"target", "organisation"} {
		t.Run(scope, func(t *testing.T) {
			f := testutil.NewFixture(t)
			seed := testutil.CreateIssue(t, f, "Seed")
			target := seed
			count := store.ImageTargetLimit - 1
			if scope == "organisation" {
				count = store.ImageWorkspaceLimit - 1
				target = testutil.CreateIssue(t, f, "New target")
			}
			_, err := f.Pool.Exec(t.Context(), `INSERT INTO image_attachment(workspace_id,issue_id,uploader_id,source,filename,caption,content_type,byte_size,width,height,data,digest)
			 SELECT $1,$2,$3,'human','seed.png','seed-'||n,'image/png',1,1,1,'x'::bytea,'seed-'||n FROM generate_series(1,$4::int) n`, f.WorkspaceID, seed.ID, f.User.ID, count)
			require.NoError(t, err)
			img, err := imageupload.Sanitize(imagePNG(t))
			require.NoError(t, err)
			base := store.ImageInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: target.ID, Filename: "proof.png", Source: "human", Image: img}
			type result struct {
				out store.ImageAttachment
				err error
			}
			results := make(chan result, 2)
			for _, caption := range []string{"one", "two"} {
				go func(caption string) {
					in := base
					in.Caption = caption
					out, err := f.Store.CreateImage(t.Context(), in)
					results <- result{out, err}
				}(caption)
			}
			first, second := <-results, <-results
			if first.err != nil {
				first, second = second, first
			}
			require.NoError(t, first.err)
			require.ErrorIs(t, second.err, store.ErrImageCount)
			base.Caption = first.out.Caption
			retry, err := f.Store.CreateImage(t.Context(), base)
			require.NoError(t, err)
			require.Equal(t, first.out.ID, retry.ID)
			var total int
			require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment`).Scan(&total))
			require.Equal(t, count+1, total)
			r := imageRequest(t, "/api/v1/w/lab/issues/"+target.Key+"/images", imagePNG(t), ptrImage("over cap"))
			imageCookie(f, r)
			rec := imageServe(f, r)
			require.Equal(t, 413, rec.Code, rec.Body.String())
			require.Contains(t, rec.Body.String(), "image_count")
			require.Contains(t, rec.Body.String(), "remove an existing image")
			require.NoError(t, f.Store.DeleteImage(t.Context(), f.WorkspaceID, first.out.ID, f.User.ID))
			base.Caption = "after removal"
			_, err = f.Store.CreateImage(t.Context(), base)
			require.NoError(t, err)
		})
	}
}

func TestImageDirectUploadUsesBytesNotDeclaredMIME(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Content sniffing")
	var jpegBytes bytes.Buffer
	require.NoError(t, jpeg.Encode(&jpegBytes, image.NewRGBA(image.Rect(0, 0, 3, 2)), nil))
	for _, tc := range []struct {
		name, declared string
		data           []byte
		want           int
		contentType    string
	}{
		{"JPEG pretending SVG", "image/svg+xml", jpegBytes.Bytes(), 201, "image/jpeg"},
		{"PNG pretending HTML", "text/html", imagePNG(t), 201, "image/png"},
		{"SVG pretending PNG", "image/png", []byte("<svg onload='alert(1)'/>"), 400, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body bytes.Buffer
			m := multipart.NewWriter(&body)
			h := textproto.MIMEHeader{}
			h.Set("Content-Disposition", `form-data; name="file"; filename="spoof.png"`)
			h.Set("Content-Type", tc.declared)
			p, err := m.CreatePart(h)
			require.NoError(t, err)
			_, err = p.Write(tc.data)
			require.NoError(t, err)
			require.NoError(t, m.WriteField("caption", tc.name))
			require.NoError(t, m.Close())
			r := httptest.NewRequest(http.MethodPost, "/api/v1/w/lab/issues/"+issue.Key+"/images", &body)
			r.Header.Set("Content-Type", m.FormDataContentType())
			imageCookie(f, r)
			rec := imageServe(f, r)
			require.Equal(t, tc.want, rec.Code, rec.Body.String())
			if tc.want == 201 {
				var out store.ImageAttachment
				f.DecodeInto(rec, &out)
				require.Equal(t, tc.contentType, out.ContentType)
			}
		})
	}
}
