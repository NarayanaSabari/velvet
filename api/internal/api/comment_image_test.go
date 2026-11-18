package api_test

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/testutil"
	"github.com/stretchr/testify/require"
)

func commentImageUpload(t *testing.T, f *testutil.Fixture, url, caption, commentID string) *httptest.ResponseRecorder {
	t.Helper()
	var b bytes.Buffer
	m := multipart.NewWriter(&b)
	require.NoError(t, m.WriteField("caption", caption))
	require.NoError(t, m.WriteField("comment_id", commentID))
	p, err := m.CreateFormFile("file", "proof.png")
	require.NoError(t, err)
	_, err = p.Write(imagePNG(t))
	require.NoError(t, err)
	require.NoError(t, m.Close())
	r := httptest.NewRequest(http.MethodPost, url, &b)
	r.Header.Set("Content-Type", m.FormDataContentType())
	imageCookie(f, r)
	return imageServe(f, r)
}

func TestCommentImages(t *testing.T) {
	f := testutil.NewFixture(t)
	issue := testutil.CreateIssue(t, f, "Proof")
	other := testutil.CreateIssue(t, f, "Other")
	base := "/api/v1/w/lab/issues/"

	rec := f.Do(http.MethodPost, base+issue.Key+"/comments", map[string]string{"body": "Proof below."})
	require.Equal(t, 201, rec.Code, rec.Body.String())
	var comment store.Comment
	f.DecodeInto(rec, &comment)

	// Attach to the comment: shown on the comment, hidden from the Images section.
	rec = commentImageUpload(t, f, base+issue.Key+"/images", "login screen", comment.ID.String())
	require.Equal(t, 201, rec.Code, rec.Body.String())
	var img store.ImageAttachment
	f.DecodeInto(rec, &img)
	require.Equal(t, comment.ID, *img.CommentID)

	// The same file on the ticket itself is a separate attachment, not a retry.
	plain := imageUpload(t, f, base+issue.Key+"/images", "login screen")
	require.NotEqual(t, img.ID, plain.ID)

	rec = f.Do(http.MethodGet, base+issue.Key+"/images", nil)
	var section struct{ Images []store.ImageAttachment }
	f.DecodeInto(rec, &section)
	require.Len(t, section.Images, 1)
	require.Equal(t, plain.ID, section.Images[0].ID)

	rec = f.Do(http.MethodGet, base+issue.Key+"/comments", nil)
	var thread struct{ Comments []store.Comment }
	f.DecodeInto(rec, &thread)
	require.Len(t, thread.Comments, 1)
	require.Len(t, thread.Comments[0].Images, 1)
	require.Equal(t, img.ID, thread.Comments[0].Images[0].ID)
	require.Equal(t, img.ContentURL, thread.Comments[0].Images[0].ContentURL)
	require.NotEmpty(t, thread.Comments[0].Images[0].ContentURL)

	// A comment on another ticket, or not a UUID, is refused.
	rec = commentImageUpload(t, f, base+other.Key+"/images", "wrong ticket", comment.ID.String())
	require.Equal(t, 422, rec.Code, rec.Body.String())
	rec = commentImageUpload(t, f, base+issue.Key+"/images", "bad id", "nope")
	require.Equal(t, 400, rec.Code, rec.Body.String())

	// Someone else's comment is refused.
	member, err := f.Store.UpsertUserByEmail(t.Context(), "member@example.com")
	require.NoError(t, err)
	_, err = f.Pool.Exec(t.Context(), `INSERT INTO membership(workspace_id,user_id,role) VALUES($1,$2,'member')`, f.WorkspaceID, member.ID)
	require.NoError(t, err)
	token, err := f.Store.CreateAPIToken(t.Context(), member.ID, "member")
	require.NoError(t, err)
	var b bytes.Buffer
	m := multipart.NewWriter(&b)
	require.NoError(t, m.WriteField("caption", "not mine"))
	require.NoError(t, m.WriteField("comment_id", comment.ID.String()))
	p, err := m.CreateFormFile("file", "x.png")
	require.NoError(t, err)
	_, err = p.Write(imagePNG(t))
	require.NoError(t, err)
	require.NoError(t, m.Close())
	r := httptest.NewRequest(http.MethodPost, base+issue.Key+"/images", &b)
	r.Header.Set("Content-Type", m.FormDataContentType())
	r.Header.Set("Authorization", "Bearer "+token)
	require.Equal(t, 422, imageServe(f, r).Code)
}
