package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/imageupload"
	"github.com/stretchr/testify/require"
)

func TestImageDecodeBusyIsRetryable(t *testing.T) {
	rec := httptest.NewRecorder()
	writeImageInputError(rec, imageupload.ErrBusy)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
	require.Equal(t, "1", rec.Header().Get("Retry-After"))
	require.Contains(t, rec.Body.String(), `"code":"image_busy"`)
	require.Contains(t, rec.Body.String(), "retry shortly")
}
