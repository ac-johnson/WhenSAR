"""Shared HTTP session for the pipeline: retries transient failures with backoff.

CMR, ASF and ArcGIS occasionally return 429/5xx or drop connections; one bad response
shouldn't fail a long backfill.
"""

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


def session():
    retry = Retry(
        total=6,
        backoff_factor=2,  # 2, 4, 8, 16, 32 s ...
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET",),
        respect_retry_after_header=True,
    )
    s = requests.Session()
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers["User-Agent"] = "WhenSAR (https://github.com/ac-johnson/WhenSAR)"
    return s
