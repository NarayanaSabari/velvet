package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/imageupload"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const ImageQuotaBytes int64 = 512 << 20
const ImageTargetLimit = 100
const ImageWorkspaceLimit = 1000

var ErrImageQuota = errors.New("organisation image quota exceeded")
var ErrImageCount = errors.New("image attachment limit reached: 100 per issue or milestone, 1000 per organisation")
var ErrUploadCredential = errors.New("invalid or expired upload credential")

type ImageAttachment struct {
	ID           uuid.UUID `json:"id"`
	Filename     string    `json:"filename"`
	Caption      string    `json:"caption"`
	ContentType  string    `json:"content_type"`
	ByteSize     int       `json:"byte_size"`
	Width        int       `json:"width"`
	Height       int       `json:"height"`
	CreatedAt    time.Time `json:"created_at"`
	UploaderID   uuid.UUID `json:"uploader_id"`
	UploaderName string    `json:"uploader_name"`
	Source       string    `json:"source"`
	ContentURL   string    `json:"content_url"`
	DownloadURL  string    `json:"download_url"`
}

type ImageInput struct {
	WorkspaceID, ActorID, TargetID        uuid.UUID
	TargetType, Filename, Caption, Source string
	APITokenID                            *uuid.UUID
	Image                                 imageupload.Image
}

type ImageGrant struct {
	ID          uuid.UUID `json:"-"`
	UploadURL   string    `json:"upload_url"`
	UploadToken string    `json:"upload_token"`
	ExpiresAt   time.Time `json:"expires_at"`
	MaxBytes    int       `json:"max_bytes"`
}

const imageCols = `i.id,i.filename,i.caption,i.content_type,i.byte_size,i.width,i.height,i.created_at,i.uploader_id,COALESCE(NULLIF(u.name,''),u.email,''),i.source`

func scanImage(row pgx.Row) (ImageAttachment, error) {
	var out ImageAttachment
	err := row.Scan(&out.ID, &out.Filename, &out.Caption, &out.ContentType, &out.ByteSize, &out.Width, &out.Height, &out.CreatedAt, &out.UploaderID, &out.UploaderName, &out.Source)
	return out, mapErr(err)
}
func imageTargetIDs(in ImageInput) (*uuid.UUID, *uuid.UUID) {
	if in.TargetType == "issue" {
		return &in.TargetID, nil
	}
	return nil, &in.TargetID
}
func lockImageWorkspace(ctx context.Context, tx pgx.Tx, id uuid.UUID) error {
	if err := lockWorkspaceTx(ctx, tx, id); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('image-workspace:' || $1::text,0))`, id)
	return err
}

// Lock both current membership and the authenticating token through commit.
// A concurrent revocation/demotion therefore serializes with this mutation.
func imageWriter(ctx context.Context, tx pgx.Tx, in ImageInput) error {
	if err := LockWorkspaceWriterTx(ctx, tx, in.WorkspaceID, in.ActorID); err != nil {
		return err
	}
	var role string
	if err := tx.QueryRow(ctx, `SELECT role::text FROM membership WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, in.WorkspaceID, in.ActorID).Scan(&role); err != nil {
		return mapErr(err)
	}
	if role != "admin" && role != "member" {
		return ErrForbidden
	}
	if in.APITokenID != nil {
		var id uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM api_token WHERE id=$1 AND user_id=$2 FOR SHARE`, in.APITokenID, in.ActorID).Scan(&id); err != nil {
			return ErrUploadCredential
		}
	}
	return checkCommentTarget(ctx, tx, in.WorkspaceID, in.TargetType, in.TargetID)
}

func (s *Store) ListImages(ctx context.Context, workspaceID uuid.UUID, targetType string, targetID uuid.UUID) ([]ImageAttachment, error) {
	out := []ImageAttachment{}
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := checkCommentTarget(ctx, tx, workspaceID, targetType, targetID); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT `+imageCols+` FROM image_attachment i JOIN app_user u ON u.id=i.uploader_id WHERE i.workspace_id=$1 AND (($2='issue' AND i.issue_id=$3) OR ($2='milestone' AND i.milestone_id=$3)) ORDER BY i.created_at,i.id`, workspaceID, targetType, targetID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			image, err := scanImage(rows)
			if err != nil {
				return err
			}
			out = append(out, image)
		}
		return rows.Err()
	})
	return out, err
}

func insertImage(ctx context.Context, tx pgx.Tx, in ImageInput) (ImageAttachment, error) {
	var out ImageAttachment
	if err := imageWriter(ctx, tx, in); err != nil {
		return out, err
	}
	hash := sha256.Sum256(in.Image.Data)
	digest := hex.EncodeToString(hash[:])
	issueID, milestoneID := imageTargetIDs(in)
	out, err := scanImage(tx.QueryRow(ctx, `SELECT `+imageCols+` FROM image_attachment i JOIN app_user u ON u.id=i.uploader_id WHERE i.workspace_id=$1 AND i.issue_id IS NOT DISTINCT FROM $2::uuid AND i.milestone_id IS NOT DISTINCT FROM $3::uuid AND i.uploader_id=$4 AND i.digest=$5 AND i.caption=$6`, in.WorkspaceID, issueID, milestoneID, in.ActorID, digest, in.Caption))
	if err == nil {
		return out, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return out, err
	}
	var used int64
	var total, targetCount int
	if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(byte_size),0),count(*),count(*) FILTER (WHERE issue_id IS NOT DISTINCT FROM $2::uuid AND milestone_id IS NOT DISTINCT FROM $3::uuid) FROM image_attachment WHERE workspace_id=$1`, in.WorkspaceID, issueID, milestoneID).Scan(&used, &total, &targetCount); err != nil {
		return out, err
	}
	if total >= ImageWorkspaceLimit || targetCount >= ImageTargetLimit {
		return out, ErrImageCount
	}
	if used+int64(len(in.Image.Data)) > ImageQuotaBytes {
		return out, ErrImageQuota
	}
	out, err = scanImage(tx.QueryRow(ctx, `WITH inserted AS (INSERT INTO image_attachment(workspace_id,issue_id,milestone_id,uploader_id,api_token_id,source,filename,caption,content_type,byte_size,width,height,data,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *) SELECT `+imageCols+` FROM inserted i JOIN app_user u ON u.id=i.uploader_id`, in.WorkspaceID, issueID, milestoneID, in.ActorID, in.APITokenID, in.Source, in.Filename, in.Caption, in.Image.ContentType, len(in.Image.Data), in.Image.Width, in.Image.Height, in.Image.Data, digest))
	if err != nil {
		return out, err
	}
	meta := map[string]any{"image_id": out.ID.String(), "caption": in.Caption, "filename": in.Filename, "source": in.Source}
	if in.APITokenID != nil {
		meta["api_token_id"] = in.APITokenID.String()
	}
	err = RecordActivity(ctx, tx, ActivityInput{WorkspaceID: in.WorkspaceID, ActorID: in.ActorID, Verb: "attached_image", TargetType: in.TargetType, TargetID: in.TargetID, Metadata: meta})
	return out, err
}
func (s *Store) CreateImage(ctx context.Context, in ImageInput) (ImageAttachment, error) {
	var out ImageAttachment
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockImageWorkspace(ctx, tx, in.WorkspaceID); err != nil {
			return err
		}
		var err error
		out, err = insertImage(ctx, tx, in)
		return err
	})
	return out, err
}
func (s *Store) ImageContent(ctx context.Context, workspaceID, id uuid.UUID) (ImageAttachment, []byte, error) {
	var out ImageAttachment
	var data []byte
	err := s.pool.QueryRow(ctx, `SELECT filename,content_type,data FROM image_attachment WHERE workspace_id=$1 AND id=$2`, workspaceID, id).Scan(&out.Filename, &out.ContentType, &data)
	return out, data, mapErr(err)
}
func (s *Store) DeleteImage(ctx context.Context, workspaceID, id, actorID uuid.UUID) error {
	return s.InTx(ctx, func(tx pgx.Tx) error {
		if err := LockWorkspaceWriterTx(ctx, tx, workspaceID, actorID); err != nil {
			return err
		}
		if err := lockImageWorkspace(ctx, tx, workspaceID); err != nil {
			return err
		}
		var owner, target uuid.UUID
		var targetType, role string
		if err := tx.QueryRow(ctx, `SELECT role::text FROM membership WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, workspaceID, actorID).Scan(&role); err != nil {
			return mapErr(err)
		}
		if err := tx.QueryRow(ctx, `SELECT uploader_id,COALESCE(issue_id,milestone_id),CASE WHEN issue_id IS NULL THEN 'milestone' ELSE 'issue' END FROM image_attachment WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, workspaceID, id).Scan(&owner, &target, &targetType); err != nil {
			return mapErr(err)
		}
		if (role != "admin" && role != "member") || (owner != actorID && role != "admin") {
			return ErrForbidden
		}
		if _, err := tx.Exec(ctx, `DELETE FROM image_attachment WHERE workspace_id=$1 AND id=$2`, workspaceID, id); err != nil {
			return err
		}
		return RecordActivity(ctx, tx, ActivityInput{WorkspaceID: workspaceID, ActorID: actorID, Verb: "deleted_image", TargetType: targetType, TargetID: target, Metadata: map[string]any{"image_id": id.String()}})
	})
}

func (s *Store) PrepareImageUpload(ctx context.Context, in ImageInput) (ImageGrant, error) {
	var out ImageGrant
	if in.APITokenID == nil {
		return out, ErrForbidden
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return out, err
	}
	out.UploadToken = "velvet_upload_" + hex.EncodeToString(raw)
	out.MaxBytes = imageupload.MaxBytes
	err := s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockImageWorkspace(ctx, tx, in.WorkspaceID); err != nil {
			return err
		}
		if err := imageWriter(ctx, tx, in); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM image_upload_grant WHERE expires_at<=now()`); err != nil {
			return err
		}
		var userCount, total int
		if err := tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE uploader_id=$2),count(*) FROM image_upload_grant WHERE workspace_id=$1`, in.WorkspaceID, in.ActorID).Scan(&userCount, &total); err != nil {
			return err
		}
		if userCount >= 20 || total >= 100 {
			return ErrRateLimited
		}
		issueID, milestoneID := imageTargetIDs(in)
		return tx.QueryRow(ctx, `INSERT INTO image_upload_grant(workspace_id,issue_id,milestone_id,uploader_id,api_token_id,token_hash,filename,caption) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,expires_at`, in.WorkspaceID, issueID, milestoneID, in.ActorID, in.APITokenID, HashToken(out.UploadToken), in.Filename, in.Caption).Scan(&out.ID, &out.ExpiresAt)
	})
	return out, err
}

// Lookup rejects expired, consumed, revoked, demoted and cross-workspace grants
// before the HTTP handler spends resources decoding an image. Consume checks
// again under locks because these values may change while the body is read.
func lookupImageGrant(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, slug string, id uuid.UUID, token string, lock bool) (ImageInput, error) {
	var in ImageInput
	var issue, milestone *uuid.UUID
	query := `SELECT g.workspace_id,g.uploader_id,g.issue_id,g.milestone_id,g.api_token_id,g.filename,g.caption FROM image_upload_grant g JOIN workspace w ON w.id=g.workspace_id JOIN api_token t ON t.id=g.api_token_id AND t.user_id=g.uploader_id JOIN membership m ON m.workspace_id=g.workspace_id AND m.user_id=g.uploader_id WHERE w.slug=$1 AND g.id=$2 AND g.token_hash=$3 AND g.expires_at>clock_timestamp() AND m.role IN ('admin','member')`
	if lock {
		query += ` FOR UPDATE OF g`
	}
	err := q.QueryRow(ctx, query, slug, id, HashToken(token)).Scan(&in.WorkspaceID, &in.ActorID, &issue, &milestone, &in.APITokenID, &in.Filename, &in.Caption)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return in, ErrUploadCredential
		}
		return in, err
	}
	in.Source = "agent"
	in.TargetType = "issue"
	if issue != nil {
		in.TargetID = *issue
	} else {
		in.TargetType = "milestone"
		in.TargetID = *milestone
	}
	return in, nil
}
func (s *Store) LookupImageUpload(ctx context.Context, slug string, id uuid.UUID, token string) (ImageInput, error) {
	return lookupImageGrant(ctx, s.pool, slug, id, token, false)
}
func (s *Store) ConsumeImageUpload(ctx context.Context, slug string, id uuid.UUID, token string, img imageupload.Image) (ImageAttachment, error) {
	var out ImageAttachment
	initial, err := s.LookupImageUpload(ctx, slug, id, token)
	if err != nil {
		return out, err
	}
	err = s.InTx(ctx, func(tx pgx.Tx) error {
		if err := lockImageWorkspace(ctx, tx, initial.WorkspaceID); err != nil {
			return err
		}
		// Token revocation locks the token before cascading to its grants.
		// Take the same lock order, never hold a grant while waiting on a token.
		if err := imageWriter(ctx, tx, initial); err != nil {
			if errors.Is(err, ErrNotFound) || errors.Is(err, ErrForbidden) {
				return ErrUploadCredential
			}
			return err
		}
		in, err := lookupImageGrant(ctx, tx, slug, id, token, true)
		if err != nil {
			return err
		}
		in.Image = img
		out, err = insertImage(ctx, tx, in)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM image_upload_grant WHERE id=$1`, id)
		return err
	})
	return out, err
}
