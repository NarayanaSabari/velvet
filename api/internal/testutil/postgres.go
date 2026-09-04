// Package testutil provides the shared test harness: a real Postgres, a
// migrated schema, and a signed-in workspace to make requests against.
package testutil

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/NarayanaSabari/velvet-otter-lab/api/internal/db"
)

// One container is shared by every test in a package, and each test clones a
// pre-migrated template database. Starting a container per test meant dozens
// racing for the daemon at once, which failed intermittently under load and
// made the suite far slower than the work it was doing.
var (
	sharedOnce sync.Once
	sharedURL  string
	sharedErr  error
	dbCounter  atomicCounter
)

type atomicCounter struct {
	mu sync.Mutex
	n  int
}

func (c *atomicCounter) next() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
	return c.n
}

// templateDB holds the migrated schema. Cloning it is a file copy inside
// Postgres, so a fresh per-test database costs milliseconds rather than a
// full migration run.
const templateDB = "ticket_template"

func startShared() {
	ctx := context.Background()

	container, err := tcpostgres.Run(ctx, "postgres:18-alpine",
		tcpostgres.WithDatabase("ticket"),
		tcpostgres.WithUsername("ticket"),
		tcpostgres.WithPassword("ticket"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(180*time.Second)),
	)
	if err != nil {
		sharedErr = fmt.Errorf("start postgres: %w", err)
		return
	}

	url, err := container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		sharedErr = fmt.Errorf("connection string: %w", err)
		return
	}

	admin, err := db.Connect(ctx, url)
	if err != nil {
		sharedErr = fmt.Errorf("connect: %w", err)
		return
	}
	defer admin.Close()

	if _, err := admin.Exec(ctx, `CREATE DATABASE `+templateDB); err != nil {
		sharedErr = fmt.Errorf("create template: %w", err)
		return
	}

	tmplPool, err := db.Connect(ctx, replaceDBName(url, templateDB))
	if err != nil {
		sharedErr = fmt.Errorf("connect template: %w", err)
		return
	}
	defer tmplPool.Close()

	if err := db.Migrate(ctx, tmplPool); err != nil {
		sharedErr = fmt.Errorf("migrate template: %w", err)
		return
	}

	sharedURL = url
}

// NewPostgres returns a pool on a private, freshly migrated database. The
// database is dropped when the test finishes.
func NewPostgres(t *testing.T) *pgxpool.Pool {
	t.Helper()
	sharedOnce.Do(startShared)
	require.NoError(t, sharedErr)

	ctx := context.Background()
	name := fmt.Sprintf("ticket_test_%d_%d", time.Now().UnixNano()%1e9, dbCounter.next())

	admin, err := db.Connect(ctx, sharedURL)
	require.NoError(t, err)
	defer admin.Close()

	_, err = admin.Exec(ctx, `CREATE DATABASE `+name+` TEMPLATE `+templateDB)
	require.NoError(t, err)

	pool, err := db.Connect(ctx, replaceDBName(sharedURL, name))
	require.NoError(t, err)

	t.Cleanup(func() {
		pool.Close()

		cleanup, err := db.Connect(ctx, sharedURL)
		if err != nil {
			return
		}
		defer cleanup.Close()
		// WITH (FORCE) so a leaked connection cannot keep the database alive
		// and leak it into the next run.
		_, _ = cleanup.Exec(ctx, `DROP DATABASE IF EXISTS `+name+` WITH (FORCE)`)
	})

	return pool
}

// replaceDBName swaps the database in a Postgres URL, keeping credentials,
// host, port, and query parameters intact.
func replaceDBName(url, name string) string {
	slash := strings.LastIndex(url, "/")
	if slash < 0 {
		return url
	}
	rest := url[slash+1:]
	query := ""
	if q := strings.Index(rest, "?"); q >= 0 {
		query = rest[q:]
	}
	return url[:slash+1] + name + query
}
