"""
Fetch an Ashby job URL and print/save the full HTTP response.
Usage: python scripts/fetch_ashby_response.py [url]
"""
import sys
from pathlib import Path

import httpx

DEFAULT_URL = (
    "https://jobs.ashbyhq.com/tambo-ai/39fcac07-6f9f-4e49-a989-26ca75aa5d5a"
)


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    with httpx.Client(follow_redirects=True, timeout=30) as client:
        r = client.get(url, headers=headers)
    html = r.text
    print("=" * 60)
    print(f"URL: {url}")
    print(f"Status: {r.status_code}")
    print(f"Content-Length: {len(html)} chars ({len(r.content)} bytes)")
    print("=" * 60)
    print("Headers:")
    for k, v in r.headers.items():
        print(f"  {k}: {v}")
    print("=" * 60)
    print("Response body:")
    print(html)
    out = Path(__file__).resolve().parent.parent / "ashby_response.html"
    out.write_text(html, encoding="utf-8")
    print("=" * 60)
    print(f"Saved to {out}")


if __name__ == "__main__":
    main()
