package db

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/png"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Exercise the production backup format with real PostgreSQL binaries, not
// copied rows. Both databases exist only inside this disposable container.
func TestImageBackupRestoresSchemaMetadataAndRawBytes(t *testing.T) {
	ctx := t.Context()
	c, err := tcpostgres.Run(ctx, "postgres:18-alpine", tcpostgres.WithDatabase("images"),
		tcpostgres.WithUsername("ticket"), tcpostgres.WithPassword("ticket"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(180*time.Second)))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, c.Terminate(context.Background())) })
	url, err := c.ConnectionString(ctx, "sslmode=disable")
	require.NoError(t, err)
	pool, err := Connect(ctx, url)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, Migrate(ctx, pool))
	_, err = pool.Exec(ctx, `INSERT INTO workspace(id,name,slug) VALUES('00000000-0000-0000-0000-000000000001','Lab','lab');
 INSERT INTO app_user(id,email) VALUES('00000000-0000-0000-0000-000000000002','backup@example.com');
 INSERT INTO membership(workspace_id,user_id,role) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','admin');
 INSERT INTO issue(id,workspace_id,key,number,title,position) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','ENG-1',1,'Backup proof','V');`)
	require.NoError(t, err)
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 3, 2))))
	data := b.Bytes()
	digest := sha256.Sum256(data)
	caption := strings.Repeat("📷", 2000)
	_, err = pool.Exec(ctx, `INSERT INTO image_attachment(workspace_id,issue_id,uploader_id,source,filename,caption,content_type,byte_size,width,height,data,digest)
 VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000002','human','proof.png',$1,'image/png',$2,3,2,$3,$4)`, caption, len(data), data, hex.EncodeToString(digest[:]))
	require.NoError(t, err)
	for _, cmd := range [][]string{
		{"pg_dump", "-U", "ticket", "-d", "images", "-Fc", "-f", "/var/lib/postgresql/images.dump"},
		{"createdb", "-U", "ticket", "restored"},
		{"pg_restore", "-U", "ticket", "-d", "restored", "--exit-on-error", "/var/lib/postgresql/images.dump"},
	} {
		code, output, err := c.Exec(ctx, cmd)
		require.NoError(t, err)
		text, err := io.ReadAll(output)
		require.NoError(t, err)
		require.Zero(t, code, "%v: %s", cmd, text)
	}
	restoredURL := strings.Replace(url, "/images?", "/restored?", 1)
	require.NotEqual(t, url, restoredURL)
	restored, err := Connect(ctx, restoredURL)
	require.NoError(t, err)
	t.Cleanup(restored.Close)
	var actualData []byte
	var actualCaption, actualFilename, actualDigest, source string
	var width, height, size int
	require.NoError(t, restored.QueryRow(ctx, `SELECT data,caption,filename,digest,source,width,height,byte_size FROM image_attachment`).Scan(&actualData, &actualCaption, &actualFilename, &actualDigest, &source, &width, &height, &size))
	require.Equal(t, data, actualData)
	require.Equal(t, caption, actualCaption)
	require.Equal(t, "proof.png", actualFilename)
	require.Equal(t, hex.EncodeToString(digest[:]), actualDigest)
	require.Equal(t, "human", source)
	require.Equal(t, []int{3, 2, len(data)}, []int{width, height, size})
	require.NoError(t, Migrate(ctx, restored), "restored migration ledger is intact")
	// Restored expression indexes and composite tenant foreign keys still guard writes.
	_, err = restored.Exec(ctx, `INSERT INTO image_attachment SELECT gen_random_uuid(),workspace_id,issue_id,milestone_id,uploader_id,api_token_id,source,filename,caption,content_type,byte_size,width,height,data,digest,created_at FROM image_attachment`)
	require.ErrorContains(t, err, "image_issue_retry_idx")
	_, err = restored.Exec(ctx, `INSERT INTO workspace(id,name,slug) VALUES('00000000-0000-0000-0000-000000000004','Other','other')`)
	require.NoError(t, err)
	_, err = restored.Exec(ctx, `UPDATE image_attachment SET workspace_id='00000000-0000-0000-0000-000000000004'`)
	require.ErrorContains(t, err, "foreign key")
	_, err = restored.Exec(ctx, `DELETE FROM issue WHERE key='ENG-1'`)
	require.NoError(t, err)
	var n int
	require.NoError(t, restored.QueryRow(ctx, `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Zero(t, n)
}
