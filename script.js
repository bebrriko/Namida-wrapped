let spotifyToken = null;
let spotifyTokenExpires = 0;

let db = null;
let metadata = {}; 
let historyData = [];
let stats = {};
let currentSlide = 0;
let userName = "";
const MAX_SLIDES = 17; 

const formatTime = (ms) => Math.round(ms / 1000 / 60);


async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyTokenExpires) return spotifyToken;

    try {
        // Теперь мы стучимся на СВОЙ сервер, а не в Spotify напрямую
        const res = await fetch('/api/spotify'); 
        
        if (!res.ok) throw new Error('Proxy error');
        
        const data = await res.json();
        if (data.access_token) {
            spotifyToken = data.access_token;
            // Делаем запас 10 секунд, чтобы токен не протух прямо во время запроса
            spotifyTokenExpires = Date.now() + (data.expires_in * 1000) - 10000;
            return spotifyToken;
        }
    } catch (e) {
        console.warn("Spotify Proxy Failed:", e);
    }
    return null;
}

// --- IMAGE FETCHING ENGINE ---
const imgCache = new Map();

async function fetchImage(artist, album = null) {
    const key = album ? `alb_${artist}_${album}` : `art_${artist}`;
    if (imgCache.has(key)) return imgCache.get(key);

    let imgUrl = null;

    // 1. SPOTIFY (THE KING) 👑
    // Пытаемся юзать споти, если есть ключи
    const token = await getSpotifyToken();
    if (token) {
        try {
            const q = album ? `album:${album} artist:${artist}` : `artist:${artist}`;
            const type = album ? 'album' : 'artist';
            const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=1`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            const items = album ? data.albums.items : data.artists.items;
            
            if (items && items.length > 0 && items[0].images.length > 0) {
                imgUrl = items[0].images[0].url; // Берём самую большую
            }
        } catch (e) {
            console.warn("Spotify Search Error:", e);
        }
    }

    // 2. LAST.FM (FALLBACK) 🤡
    // Если споти отвалился или ключей нет
    if (!imgUrl) { // Условие: если Спотифай не нашел или ключей нет
        try {
            // Формируем запрос к НАШЕМУ api
            let url = `/api/lastfm?method=${album ? 'album.getinfo' : 'artist.getinfo'}&artist=${encodeURIComponent(artist)}`;
            if (album) url += `&album=${encodeURIComponent(album)}`;
            
            const res = await fetch(url);
            if (res.ok) {
                const data = await res.json();
                
                if (album && data.album?.image) {
                    imgUrl = data.album.image.find(i=>i.size==='extralarge')['#text'];
                } else if (!album && data.artist?.image) {
                    imgUrl = data.artist.image.find(i=>i.size==='extralarge')['#text'];
                }
                
                // Фильтр битых картинок (звездочек)
                if (imgUrl && (imgUrl.includes('2a96cbd8b46e442fc41c2b86b821562f') || imgUrl === '')) imgUrl = null;
            }
        } catch(e) {
            console.warn("LastFM Proxy Error:", e);
        }
    }

    // 3. ITUNES (LAST RESORT) 🍎
    // Если вообще всё плохо
    if (!imgUrl) {
        try {
            const term = album ? `${artist} ${album}` : artist;
            const entity = album ? 'album' : 'musicArtist';
            const itunesRes = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=${entity}&limit=1`);
            const itunesData = await itunesRes.json();
            if (itunesData.resultCount > 0) {
                const art = itunesData.results[0].artworkUrl100; 
                if (art) imgUrl = art.replace('100x100bb', '600x600bb');
            }
        } catch(e) {}
    }

    if (imgUrl) imgCache.set(key, imgUrl);
    return imgUrl;
}

async function getImagesForList(items, isTracks = true) {
    return Promise.all(items.map(async (item) => {
        let img = null;
        if (isTracks) img = await fetchImage(item.meta.artist, item.meta.album);
        else img = await fetchImage(item.name);
        
        if (!img) {
            const name = isTracks ? item.meta.artist : item.name;
            const letter = name[0] ? name[0].toUpperCase() : '?';
            const colors = ['#f35', '#53f', '#3f5', '#fa0', '#0af'];
            const col = colors[name.length % colors.length];
            item.placeholderHTML = `<div style="width:100%;height:100%;background:${col};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:1.5rem;color:black">${letter}</div>`;
        }
        return { ...item, img };
    }));
}

// --- LOGIC ---
async function processFiles(masterFile) {
    const status = document.getElementById('status');
    status.innerText = "Unzipping the Master Archive... 📦";
    
    // НАСТРОЙКИ ГОДА
    const TARGET_YEAR = new Date().getFullYear(); 
    const startOfYear = new Date(`${TARGET_YEAR}-01-01T00:00:00`).getTime();
    const endOfYear = new Date(`${TARGET_YEAR}-12-31T23:59:59`).getTime();
    
    try {
        // 1. Load MASTER ZIP
        const masterZip = await JSZip.loadAsync(masterFile);
        
        // Find nested zips by name (ignoring folders path just in case)
        const localZipName = Object.keys(masterZip.files).find(name => name.endsWith('LOCAL_FILES.zip'));
        const historyZipName = Object.keys(masterZip.files).find(name => name.endsWith('TEMPDIR_History.zip'));

        if (!localZipName || !historyZipName) {
            throw new Error("Couldn't find LOCAL_FILES.zip or TEMPDIR_History.zip inside. You're sure this is the right file?");
        }

        // 2. Process LOCAL_FILES.zip (Tracks DB)
        status.innerText = "Extracting Database... 💿";
        const localZipData = await masterZip.file(localZipName).async("uint8array");
        const localZip = await JSZip.loadAsync(localZipData);
        
        let dbData = null;
        for (let f in localZip.files) {
            if (f.endsWith('tracks.db')) {
                dbData = await localZip.files[f].async("uint8array");
                break;
            }
        }
        if (!dbData) throw new Error("tracks.db wasn't found inside LOCAL_FILES.zip");

        const SQL = await initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${f}` });
        db = new SQL.Database(dbData);
        
        // Init DB Map
        const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
        let tableName = tables[0].values[0][0];
        if (tableName === 'android_metadata' && tables[0].values[1]) tableName = tables[0].values[1][0];

        const stmt = db.prepare(`SELECT * FROM ${tableName}`);
        while(stmt.step()) {
            const row = stmt.getAsObject();
            let path = row['key'] || Object.values(row)[0];
            let json = row['value'] || Object.values(row)[1];
            try {
                const m = JSON.parse(json);
                metadata[path] = {
                    title: m.title || "Unknown Track",
                    artist: m.originalArtist || m.artist || m.albumArtist || "Unknown Artist",
                    album: m.album || "Unknown Album",
                    genre: m.originalGenre || m.genre || "Unknown",
                    duration: m.durationMS || 0
                };
            } catch(e){}
        }

        // 3. Process TEMPDIR_History.zip (JSONs)
        status.innerText = "Filtering History... 📅";
        const historyZipData = await masterZip.file(historyZipName).async("uint8array");
        const histZip = await JSZip.loadAsync(historyZipData);
        
        let filteredCount = 0;
        let validCount = 0;

        for (let f in histZip.files) {
            if (f.endsWith('.json')) {
                const txt = await histZip.files[f].async("text");
                try {
                    const json = JSON.parse(txt);
                    if (Array.isArray(json)) {
                        json.forEach(item => {
                            if (item.track && item.dateAdded) {
                                // Filter 2025
                                if (item.dateAdded >= startOfYear && item.dateAdded <= endOfYear) {
                                    historyData.push({ path: item.track });
                                    validCount++;
                                } else {
                                    filteredCount++;
                                }
                            } 
                        });
                    }
                } catch(e){}
            }
        }

        console.log(`Debug: Оставили ${validCount} треков за ${TARGET_YEAR}. Смыли в унитаз ${filteredCount} старых.`);

        if (historyData.length === 0) {
            alert(`Empty in ${new Date().getFullYear()}. Either dateAdded is bad, or you have listened to nothing.`);
            status.innerText = 'No year data';
            return;
        }

        calculateStats();
        currentSlide = 1;
        renderApp();
    } catch (e) {
        console.error(e);
        alert("Error: " + e.message);
        status.innerText = "Crash: " + e.message;
    }
}

function calculateStats() {
    let totalMs = 0;
    let genres = {};
    let artists = {}; 
    let tracks = {}; 
    let albums = {}; 

    historyData.forEach(h => {
        const m = metadata[h.path];
        if (!m) return; 

        totalMs += m.duration;
        
        let g = m.genre;
        if (g) genres[g] = (genres[g] || 0) + 1;

        if (!artists[m.artist]) artists[m.artist] = { count: 0, ms: 0 };
        artists[m.artist].count++;
        artists[m.artist].ms += m.duration;

        if (!tracks[h.path]) tracks[h.path] = { count: 0, ms: 0, meta: m };
        tracks[h.path].count++;
        tracks[h.path].ms += m.duration;

        const albumKey = `${m.album}|||${m.artist}`;
        if (!albums[albumKey]) albums[albumKey] = { count: 0, ms: 0, name: m.album, artist: m.artist };
        albums[albumKey].count++;
        albums[albumKey].ms += m.duration;
    });

    stats = {
        totalMs,
        totalTracks: historyData.length,
        genres: Object.entries(genres).sort((a,b) => b[1] - a[1]),
        artists: Object.entries(artists).map(([name, data]) => ({ name, ...data })).sort((a,b) => b.ms - a.ms),
        tracks: Object.entries(tracks).map(([path, data]) => ({ path, ...data })).sort((a,b) => b.count - a.count),
        albums: Object.entries(albums).map(([key, data]) => data).sort((a,b) => b.ms - a.ms),
        totalGenres: Object.keys(genres).length,
        totalAlbums: Object.keys(albums).length,
        totalArtists: Object.keys(artists).length
    };
}

// --- CONTROLS ---
const app = document.getElementById('app');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const nav = document.getElementById('nav-controls');

function goNext() { if(currentSlide < MAX_SLIDES && currentSlide > 0) { currentSlide++; renderApp(); } }
function goPrev() { if(currentSlide > 1) { currentSlide--; renderApp(); } }

if(prevBtn) prevBtn.onclick = goPrev;
if(nextBtn) nextBtn.onclick = goNext;

// KEYBOARD SUPPORT 🎹
document.addEventListener('keydown', (e) => {
    // Если фокус на инпуте (ввод имени), стрелки не должны переключать слайды
    if(e.target.tagName === 'INPUT') return;

    if (e.key === 'ArrowRight' || e.key === 'Space' || e.key === 'Enter') goNext();
    if (e.key === 'ArrowLeft') goPrev();
});

async function renderApp() {
    if (currentSlide === 4 && stats.totalGenres <= 5) currentSlide = 7;

    if (currentSlide === 0) nav.classList.add('hidden');
    else nav.classList.remove('hidden');
    
    if(prevBtn) prevBtn.style.opacity = (currentSlide <= 1) ? '0' : '1';
    if(nextBtn) nextBtn.classList.toggle('hidden', currentSlide >= MAX_SLIDES);

    app.innerHTML = '<div class="bg-pattern"></div>'; 

    switch(currentSlide) {
        case 0:
            app.innerHTML += `
                <div class="slide-content animate-pop">
                    <h1 style="font-size:3.5rem; margin-bottom:1rem">Namida<br><span style="color:var(--accent-lime)">Wrapped</span></h1>
                    
                    <div class="file-input-wrapper">
                        <p class="text-sm text-gray-400 text-left mb-1 ml-1 font-bold">Drop your Backup Zip here 👇</p>
                        <input type="file" id="f1">
                    </div>

                    <button id="startBtn" class="btn-geo mt-4">Watch your wrapped</button>
                    
                    <button id="instrBtn" class="mt-6 text-gray-500 underline hover:text-[#d2fa39] transition text-sm font-bold cursor-pointer">
                        How to get data? ℹ️
                    </button>
                    
                    <p id="status" class="mt-4 text-sm text-gray-500"></p>

                    <!-- МОДАЛКА -->
                    <div id="instrModal" class="fixed inset-0 bg-black/95 z-[100] hidden flex items-center justify-center p-4 backdrop-blur-sm">
                        <div class="bg-[#1a1a1a] p-6 rounded-2xl max-w-md w-full border border-[#333] shadow-2xl relative text-left">
                            <button id="closeInstr" class="absolute top-4 right-4 text-2xl leading-none text-gray-400 hover:text-[#d2fa39] transition">&times;</button>
                            
                            <h2 class="text-2xl font-black text-[#d2fa39] mb-6 uppercase tracking-tighter">How to get your data?</h2>
                            
                            <ol class="list-decimal list-outside pl-5 space-y-3 text-gray-300 text-sm font-sans font-medium">
                                <li>Open <b>Namida</b> -> <b>Settings</b></li>
                                <li>Go to <b>"Backup & Restore"</b></li>
                                <li>Click <b>"Create Backup"</b></li>
                                <li>Select <b class="text-white">"History"</b> and <b class="text-white">"Database"</b></li>
                                <li>Your backup file location is stated under "Default Backup Location"</li>
                                <li>Upload the generated <b>.zip</b> file here.</li>
                                <li>Enjoy your wrapped!</li>
                            </ol>
                            
                            <button id="closeInstrBtn" class="w-full bg-[#333] hover:bg-[#d2fa39] hover:text-black text-white font-bold py-3 rounded-xl mt-6 transition">GOT IT</button>
                        </div>
                    </div>
                </div>
            `;
            
            document.getElementById('startBtn').onclick = () => {
                const f1 = document.getElementById('f1').files[0];
                if(f1) processFiles(f1);
                else alert("Файл где, Лебовски?");
            };

            const modal = document.getElementById('instrModal');
            document.getElementById('instrBtn').onclick = () => modal.classList.remove('hidden');
            const closeModal = () => modal.classList.add('hidden');
            document.getElementById('closeInstr').onclick = closeModal;
            document.getElementById('closeInstrBtn').onclick = closeModal;
            
            break;

        case 1: 
            app.innerHTML += `<div class="slide-content animate-up"><h1 class="big-stat" style="font-size:3rem; color:white">HI THERE!</h1><p class="text-2xl">This is your Namida Wrapped ${new Date().getFullYear()}</p><p class="text-gray-500 mt-2">Are you ready?</p><p class="text-xs text-gray-600 mt-4">(You can use arrow keys on your keyboard)</p></div>`; 
            break;
        
        case 2: 
            app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-3xl font-bold mb-4">You listened.<br>We counted.</h2><p class="text-gray-400 mb-4">Enter your nickname (for endcard)</p><input id="ni" type="text" class="bg-transparent border-b-2 border-white text-3xl w-full p-2 outline-none" placeholder="Name..." value="${userName}"></div>`; 
            document.getElementById('ni').oninput=(e)=>userName=e.target.value; 
            break;
        
        case 3: 
            const days = (stats.totalMs / 1000 / 60 / 60 / 24).toFixed(1);
            app.innerHTML += `<div class="slide-content animate-up"><h1 class="big-stat">${Math.round(stats.totalMs/60000).toLocaleString()}</h1><p class="text-2xl font-bold">listening minutes.</p><div class="mt-6 p-4 bg-[#222] rounded-lg"><p>That's how long you've been listening to music this year.</p><p class="mt-2 text-gray-400"> ≈ <b class="text-white">${days} days</b>.</p><p class="mt-2 text-purple-400 font-bold">Awesome, isn't it? </p></div></div>`; 
            break;
        
        case 4: app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-4xl font-bold">How many<br>genres do you think you've listened to?</h2></div>`; break;
        
        case 5: 
            const topG = stats.genres[0][0];
            const insult = topG.toLowerCase().includes('unknown') ? `<p class="text-red-400 mt-4 font-bold">Why didn't you fill genres on your songs tho? 🤡</p>` : '';
            app.innerHTML += `<div class="slide-content animate-pop"><h1 class="big-stat text-pink-500">${stats.totalGenres}</h1><p class="text-3xl font-bold">genres.</p><p class="text-xl mt-2">The perfect amount.</p>${insult}</div>`; 
            break;

        case 6: 
            const top5g = stats.genres.slice(0, 5).map(g => `<div style="background:white;color:black;display:inline-block;padding:4px 12px;margin:4px 0;font-weight:900;transform:rotate(-1deg);font-size:1.5rem">${g[0]}</div>`).join('');
            app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-2xl text-gray-400 mb-6 font-bold">Your favourite genres</h2><div class="flex flex-col items-start">${top5g}</div></div>`; 
            break;

        case 7: app.innerHTML += `<div class="slide-content animate-up"><p class="text-gray-400">You've listened to</p><h1 class="big-stat text-white my-2">${stats.totalTracks}</h1><p class="text-gray-400">songs this year.</p><p class="mt-6 text-2xl font-bold">But can you guess #1 song?</p></div>`; break;
        
        case 8: // Guess
            const correctT = stats.tracks[0];
            const opts = [...stats.tracks.slice(0, 5)].sort(()=>Math.random()-0.5);
            const htmlOpts = opts.map(t => `<button class="guess-btn" onclick="check(this, '${t.path===correctT.path}')"><div class="font-bold">${t.meta.title}</div><div class="text-xs text-gray-400">${t.meta.artist}</div></button>`).join('');
            app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-2xl font-bold mb-4">Make your pick.</h2>${htmlOpts}<p id="res" class="mt-4 font-bold min-h-[20px]"></p></div>`;
            window.check = (btn, isCorrect) => {
                const allBtns = document.querySelectorAll('.guess-btn');
                allBtns.forEach(b => b.disabled = true);
                if(isCorrect==='true') { btn.classList.add('guess-correct'); document.getElementById('res').innerText = "You got it!"; document.getElementById('res').style.color = "#d2fa39"; }
                else { btn.classList.add('guess-wrong'); document.getElementById('res').innerText = `No, it actually was ${correctT.meta.title} by ${correctT.meta.artist}`; document.getElementById('res').style.color = "#ff4444"; }
            };
            break;

        case 9: 
            const bt = stats.tracks[0];
            const bi = await fetchImage(bt.meta.artist, bt.meta.album);
            app.innerHTML += `<div class="slide-content animate-pop"><p class="text-gray-400 uppercase font-bold mb-2">Your favourite song</p>${bi?`<img src="${bi}" class="w-64 h-64 shadow-2xl mb-6 rounded-lg">`:''}<h1 class="text-3xl font-black mb-2">${bt.meta.title}</h1><p class="text-xl text-gray-300">by ${bt.meta.artist}</p><div class="mt-4 bg-white text-black px-3 py-1 inline-block font-bold">You've listened to it ${bt.count} times. Great song!</div></div>`;
            break;

        case 10: 
             const listT = await getImagesForList(stats.tracks.slice(0, 5), true);
             const htmlListT = listT.map((t, i) => `
                <div class="flex items-center gap-4 mb-4">
                    <div class="text-2xl font-black text-gray-600 w-6 text-center">${i+1}</div>
                    <div class="w-12 h-12 rounded bg-gray-800 overflow-hidden flex-shrink-0">${t.img?`<img src="${t.img}" class="w-full h-full object-cover">`:t.placeholderHTML||''}</div>
                    <div class="overflow-hidden"><div class="font-bold truncate">${t.meta.title}</div><div class="text-xs text-gray-400 truncate">${t.meta.artist}</div></div>
                </div>`).join('');
             app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-3xl font-bold mb-6">Your favourite songs</h2>${htmlListT}</div>`;
             break;

        case 11: app.innerHTML += `<div class="slide-content animate-up"><p>You've listened to</p><h1 class="big-stat text-purple-400 my-2">${stats.totalAlbums}</h1><p>albums this year</p></div>`; break;

        case 12: 
            const ba = stats.albums[0];
            const bai = await fetchImage(ba.artist, ba.name);
            app.innerHTML += `<div class="slide-content animate-pop"><p class="text-gray-400 uppercase font-bold mb-2">Your most listened album</p>${bai?`<img src="${bai}" class="w-64 h-64 shadow-2xl mb-6 rounded">`:''}<h2 class="text-2xl font-black">${ba.name}</h2><p class="text-xl text-gray-300">by ${ba.artist}</p><p class="mt-4 text-gray-500">You've listened to it for <b class="text-white">${formatTime(ba.ms)}</b> minutes. Impressive.</p></div>`;
            break;

        case 13: // Album Grid
            const albumsGrid = await Promise.all(stats.albums.slice(0, 5).map(async a => ({...a, img: await fetchImage(a.artist, a.name)})));
            let gridHTML = `<div class="album-grid-container">`;
            albumsGrid.forEach((a, i) => {
                const content = a.img ? `<img src="${a.img}">` : `<div class="w-full h-full bg-gray-800 flex items-center justify-center text-2xl font-bold">${a.name[0]}</div>`;
                gridHTML += `<div class="grid-item grid-pos-${i+1}">${content}<div class="grid-rank">${i+1}</div></div>`;
            });
            gridHTML += `</div><div class="album-text-list">`;
            albumsGrid.forEach((a, i) => {
                gridHTML += `<div class="album-text-row"><div class="album-text-rank">${i+1}</div><div class="album-text-info"><div class="album-text-name">${a.name}</div><div class="album-text-art">${a.artist}</div></div></div>`;
            });
            gridHTML += `</div>`;
            app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-2xl font-bold text-[#d2fa39] bg-black inline-block px-2">Your top albums</h2>${gridHTML}</div>`;
            break;

        case 14: 
            const insane = stats.totalArtists > 150 ? `<p class="text-red-500 font-bold mt-4 animate-pulse">That's lowkey impressive!</p>` : '';
            app.innerHTML += `<div class="slide-content animate-up"><p>You've listened to</p><h1 class="big-stat text-green-400 my-2">${stats.totalArtists}</h1><p>artists this year.</p>${insane}</div>`; 
            break;

        case 15: 
            const bArt = stats.artists[0];
            const bArtI = await fetchImage(bArt.name);
            const cool = formatTime(bArt.ms) > 3000 ? `<p class="text-purple-400 font-bold mt-4">Ебать ты крут 🔥</p>` : '';
            app.innerHTML += `<div class="slide-content animate-pop"><p class="text-gray-400">Your number one artist was</p>${bArtI?`<img src="${bArtI}" class="w-56 h-56 rounded-full border-4 border-lime-400 my-6 object-cover shadow-2xl">`:''}<h1 class="text-4xl font-black uppercase">${bArt.name}</h1><p class="mt-2">You've listened to them for <b class="text-lime-400 text-xl">${formatTime(bArt.ms)}</b> minutes.</p>${cool}</div>`;
            break;

        case 16: 
            const listA = await getImagesForList(stats.artists.slice(0, 5), false);
            const htmlListA = listA.map((a, i) => `
                <div class="flex items-center gap-4 mb-4">
                    <div class="text-2xl font-black text-gray-600 w-6 text-center">${i+1}</div>
                    <div class="w-12 h-12 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">${a.img?`<img src="${a.img}" class="w-full h-full object-cover">`:a.placeholderHTML||''}</div>
                    <div class="font-bold text-lg">${a.name}</div>
                </div>`).join('');
            app.innerHTML += `<div class="slide-content animate-up"><h2 class="text-3xl font-bold mb-8">Your favourite artists</h2>${htmlListA}</div>`;
            break;

        case 17: 
            const topArtHero = await fetchImage(stats.artists[0].name);
            const heroBg = topArtHero ? `url(${topArtHero})` : 'linear-gradient(45deg, #333, #111)';
            const colArt = stats.artists.slice(0,5).map((a,i)=>`<div class="truncate text-xs font-bold mb-1">${i+1} ${a.name}</div>`).join('');
            const colTrk = stats.tracks.slice(0,5).map((t,i)=>`<div class="truncate text-xs font-bold mb-1">${i+1} ${t.meta.title}</div>`).join('');
            let finalGenre = stats.genres[0][0];
            if ((finalGenre.toLowerCase() === 'unknown' || finalGenre.toLowerCase() === 'unknown genre') && stats.genres[1]) {
                finalGenre = stats.genres[1][0];
            }
            app.innerHTML += `
                <div class="slide-content animate-pop" style="padding:0; justify-content:center; align-items:center;">
                    <div class="summary-card" style="width:100%; max-width:380px;">
                         <div style="height:250px; width:100%; background:${heroBg} center/cover; filter:grayscale(100%) contrast(110%); position:absolute; top:0; left:0;"></div>
                         <div style="height:250px; width:100%; background:linear-gradient(to bottom, transparent, #F2F0E9 90%); position:absolute; top:0; left:0;"></div>
                         <div style="position:relative; z-index:2; margin-top:160px;">
                            <h1 style="font-size:3.5rem; line-height:0.8; color:black; margin-bottom:20px;">WRAPPED<br><span style="color:#d2fa39; -webkit-text-stroke:1px black;">2025</span></h1>
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">
                                <div><h3 style="border-bottom:2px solid black; font-size:0.8rem; margin-bottom:5px;">TOP ARTISTS</h3>${colArt}</div>
                                <div><h3 style="border-bottom:2px solid black; font-size:0.8rem; margin-bottom:5px;">TOP SONGS</h3>${colTrk}</div>
                            </div>
                            <div style="margin-top:20px; display:flex; justify-content:space-between; align-items:end;">
                                <div><div style="font-size:0.6rem; font-weight:900; color:#666;">MINUTES LISTENED</div><div style="font-size:1.5rem; font-weight:900;">${Math.round(stats.totalMs/60000).toLocaleString()}</div></div>
                                <div style="text-align:right"><div style="font-size:0.6rem; font-weight:900; color:#666;">TOP GENRE</div><div style="background:black; color:#d2fa39; padding:2px 6px; font-weight:900; display:inline-block; transform:rotate(-2deg)">${finalGenre}</div></div>
                            </div>
                         </div>
                    </div>
                    ${userName ? `<p class="mt-4 text-gray-500 text-xs font-mono">Wrapped for ${userName}</p>` : ''}
                    <button onclick="location.reload()" class="btn-geo mt-6 text-sm py-3">REPLAY</button>
                </div>
            `;
            break;
    }
}
renderApp();
