-- Upload grants let a hosted MCP client send image bytes without its API key.
-- The MCP server is gone and the velvet CLI uploads directly, so nothing
-- creates or redeems a grant any more.
DROP TABLE image_upload_grant;
