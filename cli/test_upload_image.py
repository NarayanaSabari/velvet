import email.policy
from email.parser import BytesParser
import http.server
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

CLI = str(Path(__file__).with_name('velvet'))

class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'shot; unusual.png'
        self.path.write_bytes(b'image fixture')
        self.requests = []
        self.status = 201
        outer = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                outer.requests.append((self.path, self.headers, body))
                self.send_response(outer.status)
                self.end_headers()
                self.wfile.write(json.dumps({'id': 'img', 'content_url': '/content', 'error': {'message': 'denied'}}).encode())
            def log_message(self, *args):
                pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()
        self.temp.cleanup()
    def run_cli(self, *args):
        env = {**os.environ, 'VELVET_URL': f'http://127.0.0.1:{self.server.server_port}', 'VELVET_TOKEN': 'fixture-token', 'VELVET_WORKSPACE': 'my org'}
        return subprocess.run(['bash', CLI, 'upload-image', *args], env=env, text=True, capture_output=True, timeout=10)
    def test_transport(self):
        for target, route in [('ENG-1', 'issues/ENG-1'), ('--milestone', 'milestones/m-1')]:
            args = [target] + (['m-1'] if target == '--milestone' else [])
            result = self.run_cli(*args, str(self.path), '--caption', 'why @this matters')
            self.assertEqual(result.returncode, 0, result.stderr)
            path, headers, body = self.requests[-1]
            self.assertEqual(path, '/api/v1/w/my%20org/' + route + '/images')
            self.assertEqual(headers['Authorization'], 'Bearer fixture-token')
            message = BytesParser(policy=email.policy.default).parsebytes(('Content-Type: ' + headers['Content-Type'] + '\r\n\r\n').encode() + body)
            parts = {part.get_param('name', header='content-disposition'): part for part in message.iter_parts()}
            self.assertEqual(parts['file'].get_filename(), self.path.name)
            self.assertEqual(parts['file'].get_payload(decode=True), b'image fixture')
            self.assertEqual(parts['caption'].get_payload(decode=True), b'why @this matters')
            self.assertIn('Status unchanged', result.stdout)
            self.assertIn('/w/my%20org/' + route, result.stdout)
    def test_invalid_files_and_targets(self):
        link = Path(self.temp.name) / 'link'
        link.symlink_to(self.path)
        for path in [link, Path(self.temp.name), Path(self.temp.name) / 'missing']:
            self.assertEqual(self.run_cli('ENG-1', str(path), '--caption', 'why').returncode, 2)
        with self.path.open('wb') as f:
            f.truncate(10 * 1024 * 1024 + 1)
        self.assertEqual(self.run_cli('ENG-1', str(self.path), '--caption', 'why').returncode, 2)
        self.assertEqual(self.run_cli('ENG-1', str(self.path), '--milestone', 'id', '--caption', 'why').returncode, 2)
        self.assertEqual(self.run_cli('ENG-1', str(self.path), '--caption', ' ').returncode, 2)
        self.assertEqual(self.requests, [])
    def test_http_errors(self):
        for status, code in [(401, 3), (403, 3), (404, 4), (413, 6), (415, 6)]:
            self.status = status
            result = self.run_cli('ENG-1', str(self.path), '--caption', 'why')
            self.assertEqual(result.returncode, code, result.stderr)
            self.assertIn(str(status), result.stderr)

if __name__ == '__main__':
    unittest.main()
