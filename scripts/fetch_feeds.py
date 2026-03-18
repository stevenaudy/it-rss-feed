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
    cloud|kubernetes|docker|kontainer|
    server|infrastruktur|jaringan\s*(?:komputer|internet|seluler|lokal)|
    pusat\s*data|data\s*center|
    keamanan\s*siber|serangan\s*siber|kejahatan\s*siber|siber|
    perangkat\s*keras|perangkat\s*lunak|chipset|prosesor|semikonduktor|
    kecerdasan\s*buatan|artificial\s*intelligence|
    ai\s+(?:model|tools?|agent|system|platform|server|chip)|
    llm|large\s*language|generative\s*ai|
    startup\s*(?:teknologi|tech)|fintech|
    telekomunikasi|5g|broadband|fiber\s*optik|
    malware|ransomware|hacker|kebocoran\s*data|phishing|enkripsi|
    android|ios|iphone|smartphone|
    software|firmware|source\s*code|open\s*source|
    devops|cloud\s*computing|
    aws|azure|gcp|alibaba\s*cloud|
    developer|programming|coding|
    aplikasi\s*(?:mobile|web|ai|digital|pintar)|
    internet\s*of\s*things|iot|
    wifi|bluetooth|
    chip\s*(?:ai|gpu|cpu)|gpu|cpu|
    data\s*(?:breach|leak|center|science)|
    keamanan\s*data|privasi\s*data|
    transformasi\s*digital''', re.IGNORECASE
)

# Negative blocklist — blocks clearly non-IT topics by title (for Indonesian sources)
BLOCKED_ID = re.compile(
    r'''(?x)
    cuaca|prakiraan\s*(?:cuaca|hujan)|suhu\s*(?:udara|jakarta|jawa)|
    gempa|banjir|longsor|bencana\s*alam|karhutla|kebakaran\s*hutan|
    satwa|hewan\s*(?:langka|liar)|burung|buaya|harimau|gajah|penyelundupan\s*(?:satwa|hewan)|
    hilal|lebaran|mudik|ramadan|idul\s*fitri|ketupat|
    campak|penyakit\s*(?:menular|infeksi)|vaksin|virus(?!\s*(?:komputer|malware))|covid|
    wisata|pariwisata|destinasi\s*wisata|
    candi|situs\s*(?:budaya|sejarah|arkeologi)|museum\s*(?!virtual|digital)|
    danau\s*purba|fosil|meteor|asteroid|nebula|bintang\s*(?:sekarat|mati)|
    karhutla|titik\s*api|hutan\s*(?:lindung|bakar)|
    nelayan|pertanian|perkebunan|ternak|
    gempa\s*bumi|tsunami|gunung\s*(?:api|berapi|meletus)|
    penyelundupan|perdagangan\s*satwa|
    longsor|TPST|sampah\s*(?:organik|plastik|TPA)''',
    re.IGNORECASE
)

# Sources 100% on-topic — skip keyword filter
TRUSTED_SOURCES = {
    'The Hacker News', 'Krebs on Security',
    'The New Stack', 'Detik iNet',
}

# Indonesian sources where negative blocklist applies
INDONESIA_SOURCES = {'Kompas Tekno', 'Detik iNet', 'Tempo Tekno', 'CNBC Indonesia'}

def is_relevant(title, full_text, source):
    """Return True if the article is within the IT/DevOps/Security/Cloud scope."""
    if source in TRUSTED_SOURCES:
        return True
    # Fast path: block clearly non-IT topics by title for Indonesian sources
    if source in INDONESIA_SOURCES and BLOCKED_ID.search(title):
        return False
    text = f"{title} {full_text}"
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
                raw_full = strip_html(raw)
                summary_text = trunc(raw_full, 200)
                # Relevance filter — check against FULL raw text, not truncated
                if not is_relevant(title, raw_full, c['name']):
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
