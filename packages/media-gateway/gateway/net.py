"""The one outbound-HTTP seam. Everything that calls out does it through
`net.urlopen`, so a test patches one name and reaches every caller."""
import json
from urllib.request import Request, urlopen

from gateway import config


def comfy_json(path, method='GET', data=None):
    body = None
    headers = {}
    if data is not None:
        body = json.dumps(data).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = Request(config.COMFY_HTTP_DEFAULT + path, data=body, method=method, headers=headers)
    with urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode('utf-8'))
