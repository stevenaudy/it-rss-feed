"""Server-side RSS fetcher for IT News Feed PWA — runs in GitHub Actions."""
import feedparser, json, os, re
import requests
from datetime import datetime, timezone

REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
}

def fetch_feed_content(url):
    try:
        resp = requests.get(url, headers=REQUEST_HEADERS, timeout=15)
        resp.raise_for_status()
        return resp.text
    except Exception as exc:
        print(f"    requests failed ({exc}), retrying via feedparser")
        return None

FEEDS = {
    'global': [
        {'url': 'https://thehackernews.com/feeds/posts/default',            'name': 'The Hacker News',   'category': 'Security'},
        {'url': 'https://krebsonsecurity.com/feed/',                        'name': 'Krebs on Security', 'category': 'Security'},
        {'url': 'https://thenewstack.io/feed/',                             'name': 'The New Stack',     'category': 'DevOps'},
        {'url': 'https://devops.com/feed/',                                 'name': 'DevOps.com',        'category': 'DevOps'},
        {'url': 'https://feeds.arstechnica.com/arstechnica/technology-lab', 'name': 'Ars Technica',      'category': 'Tech'},
        {'url': 'https://feed.infoq.com/',                                  'name': 'InfoQ',             'category': 'Engineering'},
    ],
    'indonesia': [
        {'url': 'https://tekno.kompas.com/rss/',          'name': 'Kompas Tekno',   'category': 'Tech'},
        {'url': 'https://rss.detik.com/inet',             'name': 'Detik iNet',     'category': 'Tech'},
        {'url': 'https://rss.tempo.co/tekno',             'name': 'Tempo Tekno',    'category': 'Tech'},
        {'url': 'https://www.cnbcindonesia.com/tech/rss', 'name': 'CNBC Indonesia', 'category': 'Tech'},
    ],
}

# ── Keyword relevance filter ─────────────────────────────────────────────────
# Articles whose title+summary contain NONE of these words are discarded.
# Covers: Infrastructure, Hardware, Technology, DevOps, Cloud, Security (EN + ID)

TECH_KEYWORDS_EN = re.compile(
    r'''(?x)
    cloud|kubernetes|k8s|docker|container|serverless|microservice|
    devops|devsecops|sre|platform\s*engineering|site\s*reliability|
    infrastructure|server|data\s*cent(?:er|re)|datacenter|
    network|firewall|load\s*balanc|vpn|dns|cdn|bgp|
    linux|unix|windows\s*server|operating\s*system|kernel|
    cpu|gpu|chip|semiconductor|processor|arm|x86|risc|
    hardware|nvme|ssd|raid|memory|ram|
    cybersecurity|cyber\s*security|security|vulnerability|cve|exploit|
    malware|ransomware|phishing|breach|hack|zero.?day|patch|
    software|programming|developer|api|sdk|open.?source|github|git|
    artificial\s*intelligence|machine\s*learning|ai\b|llm|generative|
    automation|ci.?cd|pipeline|monitoring|observability|telemetry|
    deployment|helm|terraform|ansible|puppet|chef|jenkins|
    database|sql|nosql|postgresql|mysql|mongodb|redis|elasticsearch|
    storage|backup|disaster\s*recovery|dr\b|rto|rpo|
    aws|azure|gcp|google\s*cloud|alibaba\s*cloud|
    5g|edge\s*computing|iot|internet\s*of\s*things|
    microcontroller|firmware|embedded|
    vpn|zero\s*trust|sase|siem|soar|edr|xdr|mdr|
    incident\s*response|pen\s*test|penetration|
    tech|technology|digital\s*transform''', re.IGNORECASE
)

TECH_KEYWORDS_ID = re.compile(
    r'''(?x)
    cloud|kubernetes|docker|kontainer|server|infrastruktur|jaringan|
    pusat\s*data|data\s*center|keamanan\s*siber|siber|
    perangkat\s*keras|perangkat\s*lunak|chipset|prosesor|
    aplikasi|platform|teknologi|digital|transformasi\s*digital|
    kecerdasan\s*buatan|ai\b|llm|machine\s*learning|
    startup|fintech|e.?commerce|marketplace|
    internet|wifi|5g|broadband|fiber|telekomunikasi|
    malware|ransomware|hacker|kebocoran\s*data|privasi|
    android|ios|iphone|smartphone|laptop|gadget|
    software|hardware|firmware|
    devops|otomasi|monitoring|
    aws|azure|gcp|alibaba''', re.IGNORECASE
)

# Sources we fully trust — skip keyword filter (already 100% on-topic)
TRUSTED_SOURCES = {
    'The Hacker News', 'Krebs on Security',
    'The New Stack', 'Detik iNet',
}

def is_relevant(title, summary, source):
    """Return True if the article is within the IT/DevOps/Security/Cloud scope."""
    if source in TRUSTED_SOURCES:
        return True
    text = f"{title} {summary}"
    return bool(TECH_KEYWORDS_EN.search(text) or TECH_KEYWORDS_ID.search(text))

# ── Helpers ──────────────────────────────────────────────────────────────────

def strip_html(t):
    if not t: return ''
    t = re.sub(r'<[^>]+>', ' ', t)
    t = re.sub(r'&[a-zA-Z#0-9]+;', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def trunc(t, n):
    t = t.strip()
    return t[:n].rstrip() + '\u2026' if len(t) > n else t

def to_iso(entry):
    ts = getattr(entry, 'published_parsed', None) or getattr(entry, 'updated_parsed', None)
    if ts:
        try: return datetime(*ts[:6], tzinfo=timezone.utc).isoformat()
        except: pass
    return ''

def sort_key(item):
    try: return datetime.fromisoformat(item['pubDate']).timestamp()
    except: return 0.0

os.makedirs('feeds', exist_ok=True)

for tab, configs in FEEDS.items():
    items = []
    for c in configs:
        try:
            raw_xml = fetch_feed_content(c['url'])
            feed = feedparser.parse(raw_xml if raw_xml else c['url'])
            added = skipped = 0
            for e in feed.entries:
                if added >= 20: break
                link = getattr(e, 'link', '') or ''
                if not link.startswith('https://'): continue
                title = trunc(strip_html(getattr(e, 'title', '') or ''), 120)
                raw = (getattr(e, 'summary', '') or getattr(e, 'description', '')
                       or (e.content[0].get('value', '') if hasattr(e, 'content') and e.content else ''))
                if not title: continue
                summary_text = trunc(strip_html(raw), 200)
                # Relevance filter — drop articles outside IT/DevOps/Security/Cloud scope
                if not is_relevant(title, summary_text, c['name']):
                    skipped += 1
                    continue
                items.append({'title': title, 'summary': summary_text,
                              'link': link, 'pubDate': to_iso(e),
                              'source': c['name'], 'category': c['category']})
                added += 1
            print(f"  {c['name']}: {added} items ({skipped} filtered out)")
        except Exception as ex:
            print(f"  ERROR {c['name']}: {ex}")
    items.sort(key=sort_key, reverse=True)
    out = {'fetchedAt': datetime.now(timezone.utc).isoformat(), 'items': items}
    with open(f'feeds/{tab}.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Saved {len(items)} items -> feeds/{tab}.json")

print('Done.')
