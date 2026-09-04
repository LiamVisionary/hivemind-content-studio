//! Loopback health probes.
//!
//! Deliberately hand-rolled over `TcpStream` rather than pulled from an HTTP
//! client: every probe here is a plaintext GET to 127.0.0.1, so a TLS stack and
//! a connection pool would be weight with nothing to do, and the piece worth
//! testing — reading a status line and a body without hanging — stays a pure
//! function.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Health bodies are a few hundred bytes. Anything past this is not a health
/// answer, and reading it all would let a wrong process on the port stall boot.
const MAX_BODY: usize = 8 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// Something answered HTTP on that port.
    Answered { status: u16, body: String },
    /// Nothing is listening, or it did not speak HTTP in time.
    Unreachable(String),
}

impl Probe {
    pub fn is_ok(&self) -> bool {
        matches!(self, Probe::Answered { status, .. } if (200..300).contains(status))
    }

    /// True when *anything* HTTP answered. The MCP endpoint answers a GET with
    /// 405 by design, so "reachable" is its readiness signal, not "200".
    pub fn answered(&self) -> bool {
        matches!(self, Probe::Answered { .. })
    }
}

/// Parse `HTTP/1.1 200 OK` into 200. Returns None for anything that is not a
/// status line, which is how a non-HTTP process squatting on the port reads.
pub fn parse_status_line(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse::<u16>().ok()
}

/// GET `path` from a loopback port and report what answered.
pub fn probe(port: u16, path: &str) -> Probe {
    let address = match (crate::ports::LOOPBACK, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next())
    {
        Some(address) => address,
        None => return Probe::Unreachable("could not resolve the loopback address".into()),
    };
    let mut stream = match TcpStream::connect_timeout(&address, PROBE_TIMEOUT) {
        Ok(stream) => stream,
        Err(error) => return Probe::Unreachable(error.to_string()),
    };
    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        host = crate::ports::LOOPBACK,
    );
    if let Err(error) = stream.write_all(request.as_bytes()) {
        return Probe::Unreachable(error.to_string());
    }

    let mut raw = Vec::new();
    let mut chunk = [0_u8; 2048];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                raw.extend_from_slice(&chunk[..read]);
                if raw.len() >= MAX_BODY {
                    break;
                }
            }
            Err(error) => {
                if raw.is_empty() {
                    return Probe::Unreachable(error.to_string());
                }
                break;
            }
        }
    }

    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = match text.split_once("\r\n\r\n") {
        Some((head, body)) => (head, body.to_string()),
        None => (text.as_str(), String::new()),
    };
    match head.lines().next().and_then(parse_status_line) {
        Some(status) => Probe::Answered { status, body },
        None => Probe::Unreachable("the process on that port did not answer HTTP".into()),
    }
}

/// True when the thing answering /healthz on that port is *this* product, and
/// not some other server that happens to hold 8765. This is what lets the app
/// attach to a developer stack instead of starting a second copy of it.
pub fn is_our_control_api(port: u16) -> bool {
    match probe(port, "/healthz") {
        Probe::Answered { status, body } => {
            (200..300).contains(&status) && body.contains("hivemind-content-studio")
        }
        Probe::Unreachable(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn a_status_line_yields_its_code() {
        assert_eq!(parse_status_line("HTTP/1.1 200 OK"), Some(200));
        assert_eq!(parse_status_line("HTTP/1.0 503 Service Unavailable"), Some(503));
        assert_eq!(parse_status_line("HTTP/1.1 405 Method Not Allowed"), Some(405));
    }

    #[test]
    fn a_process_that_is_not_a_web_server_is_not_a_health_answer() {
        assert_eq!(parse_status_line("SSH-2.0-OpenSSH_9.0"), None);
        assert_eq!(parse_status_line(""), None);
        assert_eq!(parse_status_line("HTTP/1.1 not-a-number"), None);
    }

    #[test]
    fn nothing_listening_reads_as_unreachable_rather_than_hanging() {
        let listener = TcpListener::bind((crate::ports::LOOPBACK, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        drop(listener);

        assert!(matches!(probe(port, "/healthz"), Probe::Unreachable(_)));
    }

    #[test]
    fn a_health_answer_carries_its_status_and_body() {
        let listener = TcpListener::bind((crate::ports::LOOPBACK, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let body = r#"{"ok":true,"service":"hivemind-content-studio"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });

        let answer = probe(port, "/healthz");

        assert!(answer.is_ok(), "{answer:?}");
        assert!(matches!(&answer, Probe::Answered { body, .. } if body.contains("hivemind-content-studio")));
        server.join().expect("server thread");
    }

    #[test]
    fn a_stranger_on_the_control_port_is_not_mistaken_for_the_studio() {
        let listener = TcpListener::bind((crate::ports::LOOPBACK, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let body = "hello from some other app";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        });

        assert!(!is_our_control_api(port));
        server.join().expect("server thread");
    }
}
