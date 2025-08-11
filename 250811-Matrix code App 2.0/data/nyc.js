/**
 * NYC Profile Service - data/nyc.js
 *
 * Minimal client that fetches lightweight records from NYC Open Data (Socrata SODA API)
 * and maps them into the canonical profile schema used by the Matrix rain app.
 *
 * Usage in `main.js`:
 * - Include this script before `main.js`.
 * - Optionally call `configureNYC({ appToken, datasetIds })` to override defaults.
 * - The app calls `NYCProfileService.fetchProfiles({ borough, nta, limit })` on demand.
 * - Results are cached in localStorage for 1 hour per key.
 * - If network fails, falls back to an embedded sample array.
 *
 * Datasets (swappable):
 * - DEMOGRAPHICS_BY_NTA: an example dataset with NTA, borough, age, income. Replace with a preferred one.
 *   Default demo: ACS 5-year profile by NTA (example id: 'i on i ly f a ke id'). Replace with a real ID.
 * - INDUSTRY_BY_NTA: optional; if present, used to map NAICS to industry/job picklists.
 */

(function () {
  const ONE_HOUR_MS = 60 * 60 * 1000;

  // Configurable constants
  const DEFAULT_DATASET_IDS = {
    // NOTE: Replace these IDs with the specific NYC Open Data dataset IDs you prefer.
    // Examples (you should verify fields and IDs on data.cityofnewyork.us):
    // - NTA Demographics & income (example placeholder): 'xxxx-xxxx'
    // - Employment/industry by NTA (placeholder): 'yyyy-yyyy'
    DEMOGRAPHICS_BY_NTA: 'xxxx-xxxx',
    INDUSTRY_BY_NTA: 'yyyy-yyyy',
  };

  let APP_TOKEN = '';
  let DATASET_IDS = { ...DEFAULT_DATASET_IDS };

  function configureNYC(opts = {}) {
    if (opts.appToken) APP_TOKEN = String(opts.appToken);
    if (opts.datasetIds) DATASET_IDS = { ...DATASET_IDS, ...opts.datasetIds };
  }

  // Basic cache layer
  function getCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const { t, v } = JSON.parse(raw);
      if (Date.now() - t > ONE_HOUR_MS) return null;
      return v;
    } catch { return null; }
  }
  function setCache(key, v) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch {}
  }

  function buildSodaUrl(datasetId, params) {
    const base = `https://data.cityofnewyork.us/resource/${datasetId}.json`;
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== '') usp.set(k, v);
    return `${base}?${usp.toString()}`;
  }

  async function sodaFetch(datasetId, queryParams) {
    const url = buildSodaUrl(datasetId, queryParams);
    const headers = {};
    if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // Fallback sample profiles if network fails
  const SAMPLE_PROFILES = [
    {
      id: 'smpl-1', name: 'Sample A', age: 24, gender: 'female', job_title: 'Student', industry: 'Education',
      income_usd: 42000, education: 'BSc', location_city: 'New York', borough: 'Manhattan', nta: 'MN013',
      relationship_status: 'single', emotional_state: 'curious', activity: 'learning', interests: ['music','ai'],
      risk_score: 37, last_active: new Date().toISOString(), coords: [358.46,155.65,411.0]
    },
    {
      id: 'smpl-2', name: 'Sample B', age: 35, gender: 'male', job_title: 'Analyst', industry: 'Finance',
      income_usd: 95000, education: 'MSc', location_city: 'New York', borough: 'Brooklyn', nta: 'BK032',
      relationship_status: 'married', emotional_state: 'focused', activity: 'commuting', interests: ['chess','biking'],
      risk_score: 29, last_active: new Date().toISOString(), coords: [402.12,210.22,512.0]
    }
  ];

  // Simple mappers/synthesizers
  const GENDERS = ['female','male','non-binary'];
  const EDUCATION = ['HS','Associate','BSc','MSc','PhD'];
  const EMOTIONS = ['focused','stressed','curious','flow','burnout','optimistic','calm','distracted'];
  const JOBS_BY_INDUSTRY = {
    Finance: ['Analyst','Trader','Auditor'],
    Healthcare: ['Nurse','Technician','Assistant'],
    Tech: ['Engineer','Developer','Data Scientist'],
    Education: ['Teacher','Student','Researcher'],
    Retail: ['Associate','Manager','Buyer'],
    Energy: ['Operator','Engineer','Planner'],
    Gaming: ['Designer','QA','Artist'],
    Media: ['Producer','Editor','Reporter'],
    Gov: ['Clerk','Analyst','Inspector'],
    Aerospace: ['Engineer','Technician','Planner'],
  };

  function rand(min, max) { return Math.random() * (max - min) + min; }
  function randi(min, max) { return Math.floor(rand(min, max)); }
  function choice(arr) { return arr[randi(0, arr.length)]; }

  function synthesizeProfileFromDemographics(row) {
    const borough = row.borough || row.boro || '';
    const nta = row.nta_code || row.ntacode || row.nta || '';
    const income = toNumber(row.median_income || row.income || row.median_household_income) || randi(30000, 110000);
    const industry = mapIndustry(row.naics || row.industry || 'Tech');
    const job = choice(JOBS_BY_INDUSTRY[industry] || ['Worker']);
    const age = mapAge(row.age || row.age_band || '25-34');
    const mood = choice(EMOTIONS);
    const risk = biasRisk(income, mood);
    return {
      id: row.id || `${nta}-${Date.now().toString(36).slice(-4)}-${randi(1000,9999)}`,
      name: row.name || `${choice(['Ava','Mia','Liam','Noah','Emma','Oliver'])} ${choice(['Kim','Lee','Nguyen','Patel','Garcia','Chen'])}`,
      age,
      gender: choice(GENDERS),
      job_title: job,
      industry,
      income_usd: income,
      education: choice(EDUCATION),
      location_city: 'New York',
      borough,
      nta,
      relationship_status: choice(['single','dating','married','complicated']),
      emotional_state: mood,
      activity: choice(['browsing','coding','commuting','meeting','streaming','learning','exercising','shopping']),
      interests: ['music','ai','biking','reading'].sort(() => Math.random() - 0.5).slice(0, randi(2,5)),
      risk_score: risk,
      last_active: new Date(Date.now() - randi(0, 3600 * 1000)).toISOString(),
      coords: [rand(100, 600).toFixed(2), rand(100, 400).toFixed(2), rand(200, 800).toFixed(1)],
    };
  }

  function toNumber(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  function mapAge(ageBand) {
    const band = String(ageBand || '').trim();
    const map = {
      'Under 5 years': 3,
      '5 to 9 years': 7,
      '10 to 14 years': 12,
      '15 to 19 years': 17,
      '20 to 24 years': 22,
      '25 to 34 years': 29,
      '35 to 44 years': 39,
      '45 to 54 years': 49,
      '55 to 59 years': 57,
      '60 to 64 years': 62,
      '65 to 74 years': 70,
      '75 to 84 years': 80,
      '85 years and over': 88,
    };
    if (map[band] !== undefined) return map[band];
    const m = /^(\d+)[^\d]+(\d+)/.exec(band);
    if (m) return Math.round((Number(m[1]) + Number(m[2])) / 2);
    const n = Number(band);
    return Number.isFinite(n) ? n : randi(20, 70);
  }
  function mapIndustry(naicsOrName) {
    const s = String(naicsOrName || '').toLowerCase();
    if (s.includes('44') || s.includes('retail')) return 'Retail';
    if (s.includes('52') || s.includes('finance')) return 'Finance';
    if (s.includes('62') || s.includes('health')) return 'Healthcare';
    if (s.includes('61') || s.includes('education')) return 'Education';
    if (s.includes('51') || s.includes('media')) return 'Media';
    if (s.includes('92') || s.includes('public')) return 'Gov';
    if (s.includes('54') || s.includes('tech') || s.includes('information')) return 'Tech';
    return 'Tech';
  }
  function biasRisk(income, mood) {
    let r = rand(10, 90);
    if (income > 150000) r -= 10;
    if (income < 40000) r += 10;
    const moodBias = { burnout: +15, stressed: +10, distracted: +8, focused: -5, calm: -5, flow: -8, optimistic: -3, curious: 0 };
    r += moodBias[mood] || 0;
    return Math.max(0, Math.min(100, Math.round(r)));
  }

  async function fetchProfiles(opts = {}) {
    const { borough = '', nta = '', limit = 200 } = opts;
    const cacheKey = `nyc_profiles:${borough}:${nta}:${limit}`;
    const cached = getCache(cacheKey);
    if (cached) return cached;

    try {
      const where = [];
      if (borough) where.push(`upper(borough) = upper('${borough.replace(/'/g, "''")}')`);
      if (nta) where.push(`upper(nta_code) = upper('${nta.replace(/'/g, "''")}')`);
      const params = {
        $limit: Math.min(Math.max(limit, 1), 500).toString(),
      };
      if (where.length) params.$where = where.join(' AND ');

      const rows = await sodaFetch(DATASET_IDS.DEMOGRAPHICS_BY_NTA, params);
      let profiles = Array.isArray(rows) ? rows.map(synthesizeProfileFromDemographics) : [];
      if (!profiles.length) profiles = SAMPLE_PROFILES;
      setCache(cacheKey, profiles);
      return profiles;
    } catch (err) {
      try { console.warn('[NYC] fetch failed, using fallback:', err && err.message); } catch {}
      return SAMPLE_PROFILES;
    }
  }

  // Exports
  window.configureNYC = configureNYC;
  window.NYCProfileService = { fetchProfiles };
})();


