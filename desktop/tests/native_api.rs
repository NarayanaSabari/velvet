// Compile client contracts without relying on UI module declarations.
// The app, not this check, uses the client API, so unused items are expected.
#![allow(dead_code)]
#[path = "../src/api.rs"]
mod api;
#[path = "../src/credentials.rs"]
mod credentials;
