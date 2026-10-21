package api_test

import (
	"bytes"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/auth"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/imageupload"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func imagePNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 3, 2))))
	return b.Bytes()
}
func imageRequest(t *testing.T, url string, data []byte, caption *string) *http.Request {
	t.Helper()
	var b bytes.Buffer
	m := multipart.NewWriter(&b)
	p, err := m.CreateFormFile("file", "test.png")
	require.NoError(t, err)
	_, err = p.Write(data)
	require.NoError(t, err)
	if caption != nil {
		require.NoError(t, m.WriteField("caption", *caption))
	}
	require.NoError(t, m.Close())
	r := httptest.NewRequest(http.MethodPost, url, &b)
	r.Header.Set("Content-Type", m.FormDataContentType())
	return r
}
func imageServe(f *testutil.Fixture, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	f.Handler.ServeHTTP(rec, r)
	return rec
}
func imageCookie(f *testutil.Fixture, r *http.Request) {
	r.AddCookie(&http.Cookie{Name: auth.CookieName, Value: f.Token})
	r.Header.Set("Origin", "http://localhost:8080")
}
func imageUpload(t *testing.T, f *testutil.Fixture, url, caption string) store.ImageAttachment {
	t.Helper()
	r := imageRequest(t, url, imagePNG(t), &caption)
	imageCookie(f, r)
	rec := imageServe(f, r)
	require.Equal(t, 201, rec.Code, rec.Body.String())
	var out store.ImageAttachment
	f.DecodeInto(rec, &out)
	return out
}
func TestImageRESTLifecycleAndPermissions(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Images")
	target := "/api/v1/w/lab/issues/" + issue.Key + "/images"
	empty := f.Do(http.MethodGet, target, nil)
	require.Equal(t, 200, empty.Code)
	require.JSONEq(t, `{"images":[]}`, empty.Body.String())
	out := imageUpload(t, f, target, "screen proof")
	require.Equal(t, "human", out.Source)
	require.Equal(t, f.User.ID, out.UploaderID)
	require.Equal(t, "Sabari", out.UploaderName)
	require.Equal(t, 3, out.Width)
	require.Equal(t, 2, out.Height)
	require.Equal(t, "image/png", out.ContentType)
	require.True(t, strings.HasPrefix(out.ContentURL, "/api/v1/w/lab/images/"))
	retry := imageUpload(t, f, target, "screen proof")
	require.Equal(t, out.ID, retry.ID)
	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM activity WHERE verb='attached_image' AND target_id=$1`, issue.ID).Scan(&count))
	require.Equal(t, 1, count)
	anonymous := imageServe(f, httptest.NewRequest(http.MethodGet, out.ContentURL, nil))
	require.Equal(t, 401, anonymous.Code)
	content := f.Do(http.MethodGet, out.ContentURL, nil)
	require.Equal(t, 200, content.Code)
	require.Equal(t, imagePNG(t), content.Body.Bytes())
	require.Equal(t, "no-store", content.Header().Get("Cache-Control"))
	require.Equal(t, "nosniff", content.Header().Get("X-Content-Type-Options"))
	require.Equal(t, "image/png", content.Header().Get("Content-Type"))
	download := f.Do(http.MethodGet, out.DownloadURL, nil)
	require.Equal(t, 200, download.Code)
	require.Contains(t, download.Header().Get("Content-Disposition"), "attachment")
	other, err := f.Store.UpsertUserByEmail(t.Context(), "member@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, other.ID)
	require.NoError(t, err)
	otherToken, err := f.Store.CreateAPIToken(t.Context(), other.ID, "member")
	require.NoError(t, err)
	require.Equal(t, 403, f.DoAsAgent(http.MethodDelete, "/api/v1/w/lab/images/"+out.ID.String(), otherToken, nil).Code)
	_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role='viewer' WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, 200, f.Do(http.MethodGet, target, nil).Code)
	require.Equal(t, 200, f.Do(http.MethodGet, out.ContentURL, nil).Code)
	require.Equal(t, 403, f.Do(http.MethodDelete, "/api/v1/w/lab/images/"+out.ID.String(), nil).Code)
	r := imageRequest(t, target, imagePNG(t), ptrImage("viewer"))
	imageCookie(f, r)
	require.Equal(t, 403, imageServe(f, r).Code)
	_, err = f.Pool.Exec(t.Context(), `UPDATE membership SET role='admin' WHERE workspace_id=$1 AND user_id=$2`, f.WorkspaceID, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, 204, f.Do(http.MethodDelete, "/api/v1/w/lab/images/"+out.ID.String(), nil).Code)
	require.Equal(t, 404, f.Do(http.MethodGet, out.ContentURL, nil).Code)
}
func ptrImage(s string) *string { return &s }

func TestImageInputLimitsAndBrowserCSRF(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Limits")
	target := "/api/v1/w/lab/issues/" + issue.Key + "/images"
	for _, test := range []struct {
		name    string
		data    []byte
		caption *string
		want    int
	}{{"missing caption", imagePNG(t), nil, 400}, {"blank caption", imagePNG(t), ptrImage("  "), 400}, {"long caption", imagePNG(t), ptrImage(strings.Repeat("x", 2001)), 400}, {"SVG", []byte("<svg/>"), ptrImage("svg"), 400}, {"truncated", imagePNG(t)[:35], ptrImage("bad"), 400}, {"bytes", make([]byte, imageupload.MaxBytes+1), ptrImage("large"), 413}} {
		t.Run(test.name, func(t *testing.T) {
			r := imageRequest(t, target, test.data, test.caption)
			imageCookie(f, r)
			require.Equal(t, test.want, imageServe(f, r).Code)
		})
	}
	for _, origin := range []string{"", "https://evil.example"} {
		r := imageRequest(t, target, imagePNG(t), ptrImage("CSRF"))
		imageCookie(f, r)
		r.Header.Set("Origin", origin)
		require.Equal(t, 403, imageServe(f, r).Code)
	}
	r := imageRequest(t, "/api/v1/w/lab/issues/"+issue.Key+"/comments", imagePNG(t), ptrImage("not image route"))
	imageCookie(f, r)
	require.Equal(t, 415, imageServe(f, r).Code)
	r = imageRequest(t, target, imagePNG(t), ptrImage("valid agent"))
	r.Header.Set("Authorization", "Bearer "+f.AgentToken("agent"))
	require.Equal(t, 201, imageServe(f, r).Code)
	var count int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment`).Scan(&count))
	require.Equal(t, 1, count)
	var source string
	var tokenID *uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT source,api_token_id FROM image_attachment`).Scan(&source, &tokenID))
	require.Equal(t, "agent", source)
	require.NotNil(t, tokenID)
}

func TestImageMilestoneCrossWorkspaceAndCascade(t *testing.T) {
	f := testutil.NewFixture(t)
	sprint := newSprint(t, f)
	rec := f.Do(http.MethodPost, "/api/v1/w/lab/sprints/"+sprint.ID.String()+"/milestones", map[string]string{"name": "Images"})
	require.Equal(t, 201, rec.Code)
	var m store.Milestone
	f.DecodeInto(rec, &m)
	target := "/api/v1/w/lab/milestones/" + m.ID.String() + "/images"
	out := imageUpload(t, f, target, "milestone")
	var foreign uuid.UUID
	require.NoError(t, f.Pool.QueryRow(t.Context(), `INSERT INTO workspace(name,slug,issue_prefix) VALUES('Foreign','foreign','FOR') RETURNING id`).Scan(&foreign))
	_, err := f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'admin')`, foreign, f.User.ID)
	require.NoError(t, err)
	require.Equal(t, 404, f.Do(http.MethodGet, strings.Replace(target, "/lab/", "/foreign/", 1), nil).Code)
	r := imageRequest(t, strings.Replace(target, "/lab/", "/foreign/", 1), imagePNG(t), ptrImage("cross"))
	imageCookie(f, r)
	require.Equal(t, 404, imageServe(f, r).Code)
	require.Equal(t, 404, f.Do(http.MethodGet, strings.Replace(out.ContentURL, "/lab/", "/foreign/", 1), nil).Code)
	require.Equal(t, 404, f.Do(http.MethodDelete, "/api/v1/w/foreign/images/"+out.ID.String(), nil).Code)
	_, err = f.Pool.Exec(t.Context(), `DELETE FROM milestone WHERE id=$1`, m.ID)
	require.NoError(t, err)
	require.Equal(t, 404, f.Do(http.MethodGet, out.ContentURL, nil).Code)
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment WHERE id=$1`, out.ID).Scan(&n))
	require.Zero(t, n)
}

func TestImageConcurrentDuplicateRetries(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Retries")
	img, err := imageupload.Sanitize(imagePNG(t))
	require.NoError(t, err)
	in := store.ImageInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: issue.ID, Filename: "a.png", Caption: "retry", Source: "human", Image: img}
	var wg sync.WaitGroup
	ids := make(chan uuid.UUID, 8)
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); out, err := f.Store.CreateImage(t.Context(), in); ids <- out.ID; errs <- err }()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	var first uuid.UUID
	for id := range ids {
		if first == uuid.Nil {
			first = id
		}
		require.Equal(t, first, id)
	}
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Equal(t, 1, n)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM activity WHERE verb='attached_image'`).Scan(&n))
	require.Equal(t, 1, n)
	_, err = f.Pool.Exec(t.Context(), `DELETE FROM issue WHERE id=$1`, issue.ID)
	require.NoError(t, err)
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Zero(t, n)
}

func TestImageLongUnicodeCaptionIsValidAndDeduplicated(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Unicode caption")
	target := "/api/v1/w/lab/issues/" + issue.Key + "/images"
	caption := strings.Repeat("📷", 2000)
	first := imageUpload(t, f, target, caption)
	retry := imageUpload(t, f, target, caption)
	require.Equal(t, caption, first.Caption)
	require.Equal(t, first.ID, retry.ID)
}

func TestImageQuotaSerializesConcurrentUploadsAndDeletionReclaimsBytes(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Quota")
	img, err := imageupload.Sanitize(imagePNG(t))
	require.NoError(t, err)
	// TOAST compresses these synthetic quota rows, keeping the real 512 MiB
	// logical quota check inexpensive without changing production constants.
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO image_attachment(workspace_id,issue_id,uploader_id,source,filename,caption,content_type,byte_size,width,height,data,digest)
	 SELECT $1,$2,$3,'human','seed.png','seed-'||n,'image/png',10485760,1,1,convert_to(repeat('x',10485760),'UTF8'),'seed-'||n FROM generate_series(1,51) n`, f.WorkspaceID, issue.ID, f.User.ID)
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO image_attachment(workspace_id,issue_id,uploader_id,source,filename,caption,content_type,byte_size,width,height,data,digest)
	 VALUES($1,$2,$3,'human','seed.png','remaining','image/png',$4,1,1,convert_to(repeat('x',$4),'UTF8'),'remaining')`, f.WorkspaceID, issue.ID, f.User.ID, (2<<20)-len(img.Data))
	require.NoError(t, err)
	base := store.ImageInput{WorkspaceID: f.WorkspaceID, ActorID: f.User.ID, TargetType: "issue", TargetID: issue.ID, Filename: "a.png", Source: "human", Image: img}
	type result struct {
		image store.ImageAttachment
		err   error
	}
	results := make(chan result, 2)
	for _, caption := range []string{"one", "two"} {
		go func(caption string) {
			in := base
			in.Caption = caption
			image, err := f.Store.CreateImage(t.Context(), in)
			results <- result{image, err}
		}(caption)
	}
	first, second := <-results, <-results
	if first.err != nil {
		first, second = second, first
	}
	require.NoError(t, first.err)
	require.ErrorIs(t, second.err, store.ErrImageQuota)
	// A duplicate retry succeeds even while the organisation is exactly full.
	base.Caption = first.image.Caption
	retry, err := f.Store.CreateImage(t.Context(), base)
	require.NoError(t, err)
	require.Equal(t, first.image.ID, retry.ID)
	require.NoError(t, f.Store.DeleteImage(t.Context(), f.WorkspaceID, first.image.ID, f.User.ID))
	base.Caption = "after delete"
	_, err = f.Store.CreateImage(t.Context(), base)
	require.NoError(t, err)
}

func TestImageActivityFailureRollsBackBytes(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Atomic images")
	target := "/api/v1/w/lab/issues/" + issue.Key + "/images"
	upload := func() int {
		r := imageRequest(t, target, imagePNG(t), ptrImage("proof"))
		imageCookie(f, r)
		return imageServe(f, r).Code
	}
	_, err := f.Pool.Exec(t.Context(), `CREATE FUNCTION reject_image_activity() RETURNS trigger AS $$ BEGIN IF NEW.verb='attached_image' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
	 CREATE TRIGGER reject_image_activity BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION reject_image_activity()`)
	require.NoError(t, err)
	require.Equal(t, http.StatusInternalServerError, upload())
	var n int
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Zero(t, n)
	_, err = f.Pool.Exec(t.Context(), `DROP TRIGGER reject_image_activity ON activity`)
	require.NoError(t, err)
	require.Equal(t, http.StatusCreated, upload())
	var status string
	require.NoError(t, f.Pool.QueryRow(t.Context(), `SELECT status::text FROM issue WHERE id=$1`, issue.ID).Scan(&status))
	require.Equal(t, "backlog", status)
}
