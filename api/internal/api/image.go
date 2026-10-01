package api

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/imageupload"
	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/google/uuid"
)

func (s *Server) registerImageRoutes(mux *http.ServeMux) {
	writer := RequireRole("admin", "member")
	for _, target := range []string{"issues/{key}", "milestones/{id}"} {
		prefix := "/api/v1/w/{slug}/" + target + "/images"
		mux.Handle("GET "+prefix, s.RequireWorkspace(http.HandlerFunc(s.handleListImages)))
		mux.Handle("POST "+prefix, s.RequireWorkspace(writer(http.HandlerFunc(s.handleCreateImage))))
		mux.Handle("POST "+prefix+"/uploads", s.RequireWorkspace(writer(http.HandlerFunc(s.handlePrepareImageUpload))))
	}
	mux.Handle("GET /api/v1/w/{slug}/images/{id}/content", s.RequireWorkspace(http.HandlerFunc(s.handleImageContent)))
	mux.Handle("DELETE /api/v1/w/{slug}/images/{id}", s.RequireWorkspace(writer(http.HandlerFunc(s.handleDeleteImage))))
	mux.HandleFunc("POST /api/v1/w/{slug}/images/uploads/{id}", s.handleConsumeImageUpload)
}

// This exact route shape is also the only custom-header browser guard bypass.
func imageGrantRequest(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	parts := strings.Split(r.URL.Path, "/")
	return len(parts) == 8 && parts[1] == "api" && parts[2] == "v1" && parts[3] == "w" && parts[4] != "" && parts[5] == "images" && parts[6] == "uploads" && parts[7] != "" && strings.TrimSpace(r.Header.Get("X-Velvet-Upload-Token")) != ""
}
func imageMultipartRequest(r *http.Request) bool {
	if r.Method != http.MethodPost {
		return false
	}
	parts := strings.Split(r.URL.Path, "/")
	return len(parts) == 8 && parts[1] == "api" && parts[2] == "v1" && parts[3] == "w" && parts[4] != "" && (parts[5] == "issues" || parts[5] == "milestones") && parts[6] != "" && parts[7] == "images"
}
func (s *Server) imageTarget(w http.ResponseWriter, r *http.Request) (string, uuid.UUID, bool) {
	if r.PathValue("key") != "" {
		id, ok := s.issueTargetID(w, r)
		return "issue", id, ok
	}
	id, ok := pathUUID(w, r, "id")
	return "milestone", id, ok
}
func imageLinks(image *store.ImageAttachment, slug string) {
	image.ContentURL = "/api/v1/w/" + url.PathEscape(slug) + "/images/" + image.ID.String() + "/content"
	image.DownloadURL = image.ContentURL + "?download=1"
}
func (s *Server) handleListImages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	target, id, ok := s.imageTarget(w, r)
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	images, err := s.store.ListImages(r.Context(), ws.WorkspaceID, target, id)
	if err != nil {
		writeImageError(w, err)
		return
	}
	for i := range images {
		imageLinks(&images[i], ws.Slug)
	}
	WriteJSON(w, http.StatusOK, map[string]any{"images": images})
}
func validImageFields(filename, caption string) (string, string, error) {
	filename = path.Base(strings.ReplaceAll(strings.TrimSpace(filename), "\\", "/"))
	caption = strings.TrimSpace(caption)
	if filename == "." || filename == "/" || !utf8.ValidString(filename) || utf8.RuneCountInString(filename) > 255 || strings.IndexFunc(filename, unicode.IsControl) >= 0 {
		return "", "", errors.New("filename is required and must be at most 255 characters without control characters")
	}
	if caption == "" || !utf8.ValidString(caption) || utf8.RuneCountInString(caption) > 2000 || strings.ContainsRune(caption, 0) {
		return "", "", errors.New("caption is required and must be at most 2000 characters")
	}
	return filename, caption, nil
}

// Stream parts into bounded memory. No multipart temp files or arbitrary URL
// fetches are involved, and client-supplied MIME types are never trusted.
func readImageMultipart(w http.ResponseWriter, r *http.Request, grant bool) (imageupload.Image, string, string, error) {
	r.Body = http.MaxBytesReader(w, r.Body, imageupload.MaxBytes+(64<<10))
	reader, err := r.MultipartReader()
	if err != nil {
		return imageupload.Image{}, "", "", errors.New("multipart/form-data is required")
	}
	var data []byte
	var filename, caption string
	seenFile, seenCaption := false, false
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return imageupload.Image{}, "", "", err
		}
		switch part.FormName() {
		case "file":
			if seenFile || part.FileName() == "" {
				return imageupload.Image{}, "", "", errors.New("exactly one file is required")
			}
			seenFile = true
			filename = part.FileName()
			data, err = io.ReadAll(io.LimitReader(part, imageupload.MaxBytes+1))
			if err != nil {
				return imageupload.Image{}, "", "", err
			}
			if len(data) > imageupload.MaxBytes {
				return imageupload.Image{}, "", "", imageupload.ErrLimit
			}
		case "caption":
			if grant || seenCaption || part.FileName() != "" {
				return imageupload.Image{}, "", "", errors.New("unexpected caption field")
			}
			seenCaption = true
			raw, err := io.ReadAll(io.LimitReader(part, 8001))
			if err != nil {
				return imageupload.Image{}, "", "", err
			}
			if len(raw) > 8000 {
				return imageupload.Image{}, "", "", errors.New("caption is too long")
			}
			caption = string(raw)
		default:
			return imageupload.Image{}, "", "", errors.New("only file and caption fields are accepted")
		}
		part.Close()
	}
	if !seenFile {
		return imageupload.Image{}, "", "", errors.New("file is required")
	}
	if !grant {
		filename, caption, err = validImageFields(filename, caption)
		if err != nil {
			return imageupload.Image{}, "", "", err
		}
	}
	img, err := imageupload.SanitizeContext(r.Context(), data)
	return img, filename, caption, err
}
func (s *Server) handleCreateImage(w http.ResponseWriter, r *http.Request) {
	target, id, ok := s.imageTarget(w, r)
	if !ok {
		return
	}
	img, filename, caption, err := readImageMultipart(w, r, false)
	if err != nil {
		writeImageInputError(w, err)
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	since, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	out, err := s.store.CreateImage(r.Context(), store.ImageInput{WorkspaceID: ws.WorkspaceID, ActorID: user.ID, TargetID: id, TargetType: target, Filename: filename, Caption: caption, Source: commentSource(r.Context()), APITokenID: currentAPIToken(r.Context()), Image: img})
	if err != nil {
		writeImageError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, since)
	imageLinks(&out, ws.Slug)
	WriteJSON(w, http.StatusCreated, out)
}
func (s *Server) handlePrepareImageUpload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !isBearerAuth(r.Context()) {
		WriteError(w, http.StatusForbidden, "forbidden", "an API token is required to prepare an upload")
		return
	}
	target, id, ok := s.imageTarget(w, r)
	if !ok {
		return
	}
	var body struct {
		Filename string `json:"filename"`
		Caption  string `json:"caption"`
	}
	if !DecodeJSON(w, r, &body) {
		return
	}
	filename, caption, err := validImageFields(body.Filename, body.Caption)
	if err != nil {
		writeImageInputError(w, err)
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	out, err := s.store.PrepareImageUpload(r.Context(), store.ImageInput{WorkspaceID: ws.WorkspaceID, ActorID: user.ID, TargetID: id, TargetType: target, Filename: filename, Caption: caption, Source: "agent", APITokenID: currentAPIToken(r.Context())})
	if err != nil {
		writeImageError(w, err)
		return
	}
	out.UploadURL = "/api/v1/w/" + url.PathEscape(ws.Slug) + "/images/uploads/" + out.ID.String()
	WriteJSON(w, http.StatusCreated, out)
}
func (s *Server) handleConsumeImageUpload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values := r.Header.Values("X-Velvet-Upload-Token")
	if len(r.Header.Values("Cookie")) != 0 || len(r.Header.Values("Authorization")) != 0 || len(values) != 1 || len(values[0]) > 256 || strings.TrimSpace(values[0]) == "" {
		WriteError(w, http.StatusUnauthorized, "unauthenticated", "an upload credential without cookies or Authorization is required")
		return
	}
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	token := values[0]
	in, err := s.store.LookupImageUpload(r.Context(), r.PathValue("slug"), id, token)
	if err != nil {
		writeImageError(w, err)
		return
	}
	img, _, _, err := readImageMultipart(w, r, true)
	if err != nil {
		writeImageInputError(w, err)
		return
	}
	since, _ := s.store.LatestActivityID(r.Context(), in.WorkspaceID)
	out, err := s.store.ConsumeImageUpload(r.Context(), r.PathValue("slug"), id, token, img)
	if err != nil {
		writeImageError(w, err)
		return
	}
	s.publishRecent(r.Context(), in.WorkspaceID, since)
	imageLinks(&out, r.PathValue("slug"))
	WriteJSON(w, http.StatusCreated, out)
}
func (s *Server) handleImageContent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	out, data, err := s.store.ImageContent(r.Context(), ws.WorkspaceID, id)
	if err != nil {
		writeImageError(w, err)
		return
	}
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": out.Filename}))
	w.Header().Set("Content-Type", out.ContentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
func (s *Server) handleDeleteImage(w http.ResponseWriter, r *http.Request) {
	id, ok := pathUUID(w, r, "id")
	if !ok {
		return
	}
	ws, _ := CurrentWorkspace(r.Context())
	user, _ := CurrentUser(r.Context())
	since, _ := s.store.LatestActivityID(r.Context(), ws.WorkspaceID)
	if err := s.store.DeleteImage(r.Context(), ws.WorkspaceID, id, user.ID); err != nil {
		writeImageError(w, err)
		return
	}
	s.publishRecent(r.Context(), ws.WorkspaceID, since)
	WriteJSON(w, http.StatusNoContent, nil)
}
func writeImageInputError(w http.ResponseWriter, err error) {
	if errors.Is(err, imageupload.ErrBusy) {
		w.Header().Set("Retry-After", "1")
		WriteError(w, http.StatusServiceUnavailable, "image_busy", "image processing is busy, retry shortly")
		return
	}
	var max *http.MaxBytesError
	if errors.Is(err, imageupload.ErrLimit) || errors.As(err, &max) {
		WriteError(w, http.StatusRequestEntityTooLarge, "image_limit", "image exceeds 10 MiB or 20 megapixels")
		return
	}
	WriteError(w, http.StatusBadRequest, "invalid_request", "valid PNG, JPEG or WebP file and required caption expected")
}
func writeImageError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrUploadCredential):
		WriteError(w, http.StatusUnauthorized, "unauthenticated", "invalid or expired upload credential")
	case errors.Is(err, store.ErrForbidden):
		WriteError(w, http.StatusForbidden, "forbidden", "insufficient image permission")
	case errors.Is(err, store.ErrImageQuota):
		WriteError(w, http.StatusRequestEntityTooLarge, "image_quota", "organisation image quota is 512 MiB")
	case errors.Is(err, store.ErrImageCount):
		WriteError(w, http.StatusRequestEntityTooLarge, "image_count", "image limit is 100 per issue or milestone and 1000 per organisation; remove an existing image before uploading")
	case errors.Is(err, store.ErrRateLimited):
		WriteError(w, http.StatusTooManyRequests, "rate_limited", "too many outstanding image uploads")
	default:
		writeStoreError(w, err, "image")
	}
}
