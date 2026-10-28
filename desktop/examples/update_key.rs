//! Release signing helper for the desktop updater.
//!
//!   cargo run --example update_key -- generate <private-key-file>
//!   cargo run --example update_key -- sign <private-key-file> <version> <sha256>
//!
//! `generate` writes a PKCS#8 hex private key (mode 600) and prints the public
//! key hex for `desktop/update-public-key.hex`. `sign` prints a signature hex.
use ring::signature::{Ed25519KeyPair, KeyPair};
use std::os::unix::fs::OpenOptionsExt;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["generate", file] => {
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .expect("key generation failed");
            let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
            let mut out = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(file)
                .expect("refusing to overwrite an existing key file");
            std::io::Write::write_all(&mut out, hex(pkcs8.as_ref()).as_bytes()).unwrap();
            println!("{}", hex(pair.public_key().as_ref()));
        }
        ["sign", file, version, sha256] => {
            let text = std::fs::read_to_string(file).expect("cannot read key file");
            let text = text.trim();
            let bytes: Vec<u8> = (0..text.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("invalid key hex"))
                .collect();
            let pair = Ed25519KeyPair::from_pkcs8(&bytes).expect("invalid private key");
            let message = format!("velvet-desktop:{version}:{}", sha256.to_ascii_lowercase());
            println!("{}", hex(pair.sign(message.as_bytes()).as_ref()));
        }
        _ => {
            eprintln!("usage: update_key generate <file> | sign <file> <version> <sha256>");
            std::process::exit(2);
        }
    }
}
