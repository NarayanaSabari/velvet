package db

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestImageMigrationUpgradeConstraintsAndCascade(t *testing.T) {
	pool := databaseBefore(t, "0012_image_attachments.sql")
	ctx := t.Context()
	_, err := pool.Exec(ctx, `INSERT INTO workspace(id,name,slug) VALUES('00000000-0000-0000-0000-000000000001','Lab','lab'),('00000000-0000-0000-0000-000000000002','Other','other');
 INSERT INTO app_user(id,email) VALUES('00000000-0000-0000-0000-000000000003','image@example.com');
 INSERT INTO project(id,workspace_id,key,name) VALUES('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','web','Web');
 INSERT INTO sprint(id,workspace_id,project_id,name,starts_on,ends_on) VALUES('00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','Sprint','2026-10-01','2026-10-31');
 INSERT INTO milestone(id,workspace_id,sprint_id,name,position) VALUES('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005','Milestone','V');
 INSERT INTO issue(id,workspace_id,key,number,title,position) VALUES('00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000001','ENG-1',1,'Existing work','V');`)
	require.NoError(t, err)
	require.NoError(t, Migrate(ctx, pool))
	require.NoError(t, Migrate(ctx, pool))
	var title string
	require.NoError(t, pool.QueryRow(ctx, `SELECT title FROM issue`).Scan(&title))
	require.Equal(t, "Existing work", title)
	issue := "00000000-0000-0000-0000-000000000007"
	milestone := "00000000-0000-0000-0000-000000000006"
	ws := "00000000-0000-0000-0000-000000000001"
	insert := func(workspace string, issue, milestone any, size, width, height int) error {
		_, err := pool.Exec(ctx, `INSERT INTO image_attachment(workspace_id,issue_id,milestone_id,uploader_id,source,filename,caption,content_type,byte_size,width,height,data,digest) VALUES($1,$2,$3,'00000000-0000-0000-0000-000000000003','human','a.png','proof','image/png',$4,$5,$6,convert_to(repeat('x',$4),'UTF8'),gen_random_uuid()::text)`, workspace, issue, milestone, size, width, height)
		return err
	}
	require.Error(t, insert(ws, nil, nil, 1, 1, 1))
	require.Error(t, insert(ws, issue, milestone, 1, 1, 1))
	require.Error(t, insert("00000000-0000-0000-0000-000000000002", issue, nil, 1, 1, 1))
	require.Error(t, insert(ws, issue, nil, 10485761, 1, 1))
	require.Error(t, insert(ws, issue, nil, 1, 5000, 5000))
	require.NoError(t, insert(ws, issue, nil, 1, 1, 1))
	require.NoError(t, insert(ws, nil, milestone, 1, 1, 1))
	_, err = pool.Exec(ctx, `DELETE FROM issue WHERE id=$1`, issue)
	require.NoError(t, err)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Equal(t, 1, n)
	_, err = pool.Exec(ctx, `DELETE FROM workspace WHERE id=$1`, ws)
	require.NoError(t, err)
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM image_attachment`).Scan(&n))
	require.Zero(t, n)
}
