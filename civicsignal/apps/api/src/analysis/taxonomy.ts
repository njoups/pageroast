/**
 * Default topic taxonomy for government communications and public affairs. Keys are stable identifiers stored with
 * every classification together with TAXONOMY_VERSION. Cue words are used only by the rule-based baseline; LLM
 * providers receive the labels and descriptions. A trailing '*' means prefix match.
 * Projects can add their own categories (key prefix 'custom:') via the API.
 */
export const TAXONOMY_VERSION = 'gov-pa/1';

export interface TopicDef { key: string; label: string; labelId: string; description: string; cues: string[] }

export const DEFAULT_TOPICS: TopicDef[] = [
  { key: 'government_policy', label: 'Government policy', labelId: 'Kebijakan pemerintah', description: 'Laws, regulations, budgets, subsidies, legislative activity',
    cues: ['kebijakan', 'regulasi', 'peraturan', 'undang*', 'perpres', 'permen*', 'anggaran', 'apbn', 'apbd', 'subsidi', 'dpr', 'dprd', 'legislasi', 'rapat', 'policy', 'policies', 'regulation*', 'law', 'laws', 'bill', 'budget*', 'subsid*', 'parliament*', 'legislat*', 'decree*', 'hearing'] },
  { key: 'public_services', label: 'Public services', labelId: 'Layanan publik', description: 'Administrative services, permits, utilities, service quality',
    cues: ['layanan', 'pelayanan', 'ktp', 'dukcapil', 'perizinan', 'izin', 'administrasi', 'antrean', 'pdam', 'air', 'listrik', 'pembuatan', 'service*', 'permit*', 'licens*', 'queue*', 'water', 'electricity', 'utilit*'] },
  { key: 'economy', label: 'Economy', labelId: 'Ekonomi', description: 'Prices, inflation, trade, investment, monetary policy, business conditions',
    cues: ['ekonomi', 'inflasi', 'harga', 'pasar', 'ekspor', 'impor', 'umkm', 'investasi', 'suku', 'bunga', 'bank', 'rupiah', 'pertumbuhan', 'pajak', 'pedagang', 'beli', 'economy', 'economic*', 'inflation', 'price*', 'market*', 'export*', 'import*', 'invest*', 'interest', 'rates', 'currency', 'growth', 'tax*', 'traders', 'demand'] },
  { key: 'infrastructure', label: 'Infrastructure', labelId: 'Infrastruktur', description: 'Roads, bridges, dams, ports, construction projects',
    cues: ['infrastruktur', 'jalan', 'tol', 'jembatan', 'bendungan', 'pelabuhan', 'bandara', 'proyek', 'pembangunan', 'konstruksi', 'infrastructure', 'road*', 'toll', 'bridge*', 'dam', 'dams', 'port', 'airport*', 'construction'] },
  { key: 'health', label: 'Health', labelId: 'Kesehatan', description: 'Health services, disease, hospitals, public health programmes',
    cues: ['kesehatan', 'rumah sakit', 'puskesmas', 'pasien', 'dokter', 'penyakit', 'demam', 'berdarah', 'wabah', 'vaksin*', 'obat', 'gizi', 'stunting', 'health*', 'hospital*', 'clinic*', 'patient*', 'doctor*', 'disease*', 'dengue', 'outbreak*', 'vaccin*', 'medic*'] },
  { key: 'education', label: 'Education', labelId: 'Pendidikan', description: 'Schools, universities, students, exams, curricula',
    cues: ['pendidikan', 'sekolah', 'siswa', 'mahasiswa', 'guru', 'ujian', 'kurikulum', 'universitas', 'beasiswa', 'olimpiade', 'education', 'school*', 'student*', 'teacher*', 'exam*', 'curricul*', 'universit*', 'scholarship*', 'olympiad'] },
  { key: 'environment', label: 'Environment', labelId: 'Lingkungan', description: 'Natural hazards, pollution, forests, climate, environmental quality',
    cues: ['lingkungan', 'banjir', 'longsor', 'karhutla', 'kebakaran hutan', 'polusi', 'pencemaran', 'sampah', 'emisi', 'iklim', 'kualitas udara', 'pohon', 'gempa', 'environment*', 'flood*', 'landslide*', 'wildfire*', 'pollution', 'waste', 'emission*', 'climate', 'air quality', 'earthquake*'] },
  { key: 'transportation', label: 'Transportation', labelId: 'Transportasi', description: 'Public transport, traffic, aviation, shipping, travel',
    cues: ['transportasi', 'kereta', 'krl', 'bus', 'angkutan', 'penerbangan', 'pesawat', 'kemacetan', 'macet', 'lalu lintas', 'mudik', 'penumpang', 'transport*', 'train*', 'commuter*', 'flight*', 'airline*', 'traffic', 'congestion', 'passenger*'] },
  { key: 'public_safety', label: 'Public safety', labelId: 'Keamanan publik', description: 'Crime, policing, law enforcement, corruption cases, accidents',
    cues: ['polisi', 'polri', 'kapolri', 'kriminal', 'pencurian', 'pembunuhan', 'narkoba', 'korupsi', 'kpk', 'kejaksaan', 'penangkapan', 'ditangkap', 'tersangka', 'kecelakaan', 'pidana', 'penyidikan', 'evakuasi', 'mengevakuasi', 'police', 'crime*', 'arrest*', 'suspect*', 'corruption', 'theft', 'murder*', 'drug*', 'accident*', 'rescu*'] },
  { key: 'public_communication', label: 'Public communication', labelId: 'Komunikasi publik', description: 'Official statements, press conferences, misinformation, public reaction',
    cues: ['juru bicara', 'konferensi pers', 'pernyataan', 'klarifikasi', 'hoaks', 'disinformasi', 'siaran pers', 'sosialisasi', 'warganet', 'viral', 'kecaman', 'spokesperson', 'press conference', 'statement*', 'clarif*', 'hoax*', 'misinformation', 'disinformation', 'press release', 'remarks', 'backlash'] },
  { key: 'corporate_reputation', label: 'Corporate reputation', labelId: 'Reputasi korporasi', description: 'Companies, brands, consumer complaints, lawsuits against companies',
    cues: ['perusahaan', 'korporasi', 'merek', 'produk', 'konsumen', 'gugatan', 'digugat', 'boikot', 'company', 'companies', 'corporat*', 'brand*', 'consumer*', 'lawsuit*', 'sued', 'boycott*', 'reputation'] },
  { key: 'technology', label: 'Technology', labelId: 'Teknologi', description: 'Digital services, apps, cyber security, data, innovation',
    cues: ['teknologi', 'digital', 'aplikasi', 'startup', 'siber', 'data', 'internet', 'kecerdasan buatan', 'daring', 'technology', 'app', 'apps', 'startup*', 'cyber*', 'software', 'online', 'artificial intelligence'] },
  { key: 'international_affairs', label: 'International affairs', labelId: 'Hubungan internasional', description: 'Diplomacy, bilateral relations, international organisations, borders',
    cues: ['luar negeri', 'diplomasi', 'bilateral', 'kerja sama', 'delegasi', 'asean', 'pbb', 'negara tetangga', 'perbatasan', 'internasional', 'foreign', 'diplomat*', 'delegation*', 'united nations', 'border*', 'international', 'neighbouring', 'neighboring'] },
  { key: 'other', label: 'Other', labelId: 'Lainnya', description: 'Clearly identifiable subject outside the categories above', cues: [] },
  { key: 'unknown', label: 'Unknown', labelId: 'Tidak diketahui', description: 'Insufficient evidence to classify', cues: [] },
];

export const TOPIC_KEYS = new Set(DEFAULT_TOPICS.map((t) => t.key));
export const topicLabel = (key: string): string => DEFAULT_TOPICS.find((t) => t.key === key)?.label ?? key;

export interface CustomTopic { id: string; key: string; label: string; description: string | null; keywords: string[] }
