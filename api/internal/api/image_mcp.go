package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/store"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type imageToolTarget struct {
	Key         string `json:"key,omitempty" jsonschema:"Issue key, mutually exclusive with milestone_id"`
	MilestoneID string `json:"milestone_id,omitempty" jsonschema:"Milestone UUID, mutually exclusive with key"`
}
type prepareImageToolInput struct {
	Key         string `json:"key,omitempty" jsonschema:"Issue key, mutually exclusive with milestone_id"`
	MilestoneID string `json:"milestone_id,omitempty" jsonschema:"Milestone UUID, mutually exclusive with key"`
	Filename    string `json:"filename" jsonschema:"Original image filename, not a local path or URL"`
	Caption     string `json:"caption" jsonschema:"Required concise description of the image"`
}

func imageToolPath(c *mcpCall, in imageToolTarget) (string, error) {
	key := mcpKey(in.Key)
	milestone := strings.TrimSpace(in.MilestoneID)
	if (key == "") == (milestone == "") {
		return "", errors.New("pass exactly one of key or milestone_id")
	}
	if key != "" {
		return c.scoped() + "/issues/" + url.PathEscape(key) + "/images", nil
	}
	id, err := uuid.Parse(milestone)
	if err != nil {
		return "", errors.New("milestone_id must be a UUID")
	}
	return c.scoped() + "/milestones/" + id.String() + "/images", nil
}
func registerImageMCPTools(server *mcp.Server, baseURL string, api http.Handler) {
	tool(server, baseURL, api, "velvet_list_images", "List image attachment metadata and protected content/download links for one issue or milestone. Never returns image binary.", func(ctx context.Context, c *mcpCall, in imageToolTarget) (string, error) {
		target, err := imageToolPath(c, in)
		if err != nil {
			return "", err
		}
		var out struct {
			Images []store.ImageAttachment `json:"images"`
		}
		if err = c.do(ctx, http.MethodGet, target, nil, &out); err != nil {
			return "", err
		}
		for i := range out.Images {
			out.Images[i].ContentURL = c.baseURL + out.Images[i].ContentURL
			out.Images[i].DownloadURL = c.baseURL + out.Images[i].DownloadURL
		}
		raw, err := json.Marshal(out)
		return string(raw), err
	})
	tool(server, baseURL, api, "velvet_prepare_image_upload", "Prepare a 10-minute single-use image upload for one issue or milestone. Returns JSON upload_url, upload_token, expires_at, max_bytes and header_name. The caller uploads its local file directly using POST multipart file and X-Velvet-Upload-Token, without cookies or Authorization. This hosted tool cannot read local files and accepts no paths, URLs or base64 image data. Caption is required. PNG, JPEG and static WebP only, at most 10 MiB and 20 megapixels.", func(ctx context.Context, c *mcpCall, in prepareImageToolInput) (string, error) {
		target, err := imageToolPath(c, imageToolTarget{Key: in.Key, MilestoneID: in.MilestoneID})
		if err != nil {
			return "", err
		}
		if strings.ContainsAny(in.Filename, "/\\") {
			return "", errors.New("filename must be a filename, not a path or URL")
		}
		var grant store.ImageGrant
		if err = c.do(ctx, http.MethodPost, target+"/uploads", map[string]string{"filename": in.Filename, "caption": in.Caption}, &grant); err != nil {
			return "", err
		}
		grant.UploadURL = c.baseURL + grant.UploadURL
		out := struct {
			store.ImageGrant
			HeaderName string `json:"header_name"`
			Method     string `json:"method"`
			FileField  string `json:"file_field"`
		}{grant, "X-Velvet-Upload-Token", "POST", "file"}
		raw, err := json.Marshal(out)
		return string(raw), err
	})
}
