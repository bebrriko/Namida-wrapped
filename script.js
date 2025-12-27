let spotifyToken = null;
let spotifyTokenExpires = 0;

let db = null;
let metadata = {}; 
let historyData = [];
let stats = {};
let currentSlide = 0;
let userName = "";
// Увеличили макс слайдов, так как добавили 2 новых
const MAX_SLIDES = 19; 
// --- НОВАЯ СИСТЕМА НАВИГАЦИИ ---
let isMobile = window.innerWidth <= 768;
let touchStartX = 0;
let touchEndX = 0;
let touchStartY = 0;
let touchEndY = 0;
const appContainer = document.getElementById('app');

// --- SPOTIFY VIBE MOVEMENT ---
const orb1 = document.querySelector('.orb-1');
const orb2 = document.querySelector('.orb-2');

let bgHistory = [{ x1: 0, y1: 0, x2: 0, y2: 0 }];

function updateBackground(direction) {
    let pos;

    if (direction === 'next') {
        // Генерируем "мягкие" координаты.
        // Двигаем всего на ±15%, чтобы они не улетали далеко от своих углов
        pos = {
            x1: (Math.random() - 0.5) * 50, // Зеленый: чуть влево/вправо
            y1: (Math.random() - 0.5) * 50, // Зеленый: чуть вверх/вниз
            
            x2: (Math.random() - 0.5) * 50, // Фиолетовый: чуть влево/вправо
            y2: (Math.random() - 0.5) * 50  // Фиолетовый: чуть вверх/вниз
        };
        bgHistory.push(pos);
    } else if (direction === 'prev') {
        if (bgHistory.length > 1) bgHistory.pop();
        pos = bgHistory[bgHistory.length - 1];
    } else {
        bgHistory = [{ x1: 0, y1: 0, x2: 0, y2: 0 }];
        pos = bgHistory[0];
    }
    
    if (!pos) pos = { x1: 0, y1: 0, x2: 0, y2: 0 };

    // ВАЖНО: Мы добавляем смещение к их ИСХОДНЫМ позициям (top/left/bottom/right в CSS).
    // translate(0,0) вернет их в исходный угол.
    if(orb1) orb1.style.transform = `translate(${pos.x1}%, ${pos.y1}%) scale(${1 + Math.random() * 0.3})`; 
    if(orb2) orb2.style.transform = `translate(${pos.x2}%, ${pos.y2}%) scale(${1 + Math.random() * 0.3})`;
}

// Основная функция навигации
function navigateTo(slideIndex, direction) {
    if (slideIndex < 0 || slideIndex >= MAX_SLIDES) {
        return;
    }
    
    currentSlide = slideIndex;
    
    // Двигаем контейнер со слайдами
    if (isMobile) {
        appContainer.style.transform = `translateY(-${currentSlide * 100}vh)`;
    } else {
        appContainer.style.transform = `translateX(-${currentSlide * 100}vw)`;
    }
    
    // Двигаем фон
    updateBackground(direction);

    // Показываем/скрываем стрелки
    document.getElementById('prevBtn').style.display = currentSlide === 0 ? 'none' : 'block';
    document.getElementById('nextBtn').style.display = currentSlide === MAX_SLIDES - 1 ? 'none' : 'block';
}


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

// --- PRELOADER 🚀 ---
async function preloadAssets() {
    const status = document.getElementById('status');
    status.innerText = "Downloading Arts... 🎨 (Hold tight)";

    const promises = [];

    // 1. Топ трек и топ-5 треков
    if (stats.tracks.length > 0) {
        // Top 1
        promises.push(fetchImage(stats.tracks[0].meta.artist, stats.tracks[0].meta.album));
        // Top 5 list
        stats.tracks.slice(0, 5).forEach(t => {
            promises.push(fetchImage(t.meta.artist, t.meta.album));
        });
    }

    // 2. Топ альбом и топ-5 альбомов
    if (stats.albums.length > 0) {
        // Top 1
        promises.push(fetchImage(stats.albums[0].artist, stats.albums[0].name));
        // Top 5 grid
        stats.albums.slice(0, 5).forEach(a => {
            promises.push(fetchImage(a.artist, a.name));
        });
    }

    // 3. Топ артист и топ-5 артистов
    if (stats.artists.length > 0) {
        // Top 1
        promises.push(fetchImage(stats.artists[0].name));
        // Top 5 list
        stats.artists.slice(0, 5).forEach(a => {
            promises.push(fetchImage(a.name));
        });
    }

    // Ждём пока всё загрузится (используем allSettled, чтобы одна ошибка не положила всё)
    // Это заполнит твой imgCache
    await Promise.allSettled(promises);
    
    console.log("Preload complete! Cache size:", imgCache.size);
}

// --- LOGIC ---
async function processFiles(masterFile) {
    const status = document.getElementById('status');
    status.innerText = "Unzipping the Master Archive... 📦";
    
    // НАСТРОЙКИ ГОДА
    const now = new Date();
    const currentMonth = now.getMonth();
    const TARGET_YEAR = currentMonth === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const startOfYear = new Date(`${TARGET_YEAR}-01-01T00:00:00`).getTime();
    const endOfYear = new Date(`${TARGET_YEAR}-12-31T23:59:59`).getTime();
    
    try {
        // 1. Load MASTER ZIP
        const masterZip = await JSZip.loadAsync(masterFile);
        
        // Find nested zips by name (ignoring folders path just in case)
        const localZipName = Object.keys(masterZip.files).find(name => name.endsWith('LOCAL_FILES.zip'));
        const historyZipName = Object.keys(masterZip.files).find(name => name.endsWith('TEMPDIR_History.zip'));

        if (!localZipName || !historyZipName) {
            throw new Error("Couldn't find LOCAL_FILES.zip or TEMPDIR_History.zip inside.");
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
        if (!dbData) throw new Error("tracks.db not found");

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
                                    historyData.push({ path: item.track, dateAdded: item.dateAdded });
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

        // --- ВОТ ТУТ ИЗМЕНЕНИЯ ---
        // Сначала грузим всё тяжелое, пока юзер смотрит на лоадер
        await preloadAssets(); 
        
        status.innerText = "Ready! 🚀";
        // -------------------------

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
    let days = {}; // --- NEW: Считаем дни

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

        // --- NEW: LOGIC FOR DAYS ---

        // Получаем дату в формате "YYYY-MM-DD"

        const dateObj = new Date(h.dateAdded);

        // Чтобы не было проблем с часовыми поясами, используем toISOString и берем начало

        const dayKey = dateObj.toISOString().split('T')[0]; 

        

        if (!days[dayKey]) days[dayKey] = { count: 0, ms: 0, dateObj: dateObj };

        days[dayKey].count++;

        days[dayKey].ms += m.duration;
    });

    // --- NEW: Find Top Day ---

    const sortedDays = Object.values(days).sort((a,b) => b.count - a.count);

    const topDay = sortedDays.length > 0 ? sortedDays[0] : null;

    stats = {
        totalMs,
        totalTracks: historyData.length,
        genres: Object.entries(genres).sort((a,b) => b[1] - a[1]),
        artists: Object.entries(artists).map(([name, data]) => ({ name, ...data })).sort((a,b) => b.ms - a.ms),
        tracks: Object.entries(tracks).map(([path, data]) => ({ path, ...data })).sort((a,b) => b.count - a.count),
        albums: Object.entries(albums).map(([key, data]) => data).sort((a,b) => b.ms - a.ms),
        topDay: topDay, // Сохраняем лучший день
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

// --- ОБРАБОТЧИКИ СОБЫТИЙ ---

// Свайпы на мобилке
appContainer.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
}, { passive: true });

appContainer.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    touchEndY = e.changedTouches[0].screenY;
    handleSwipe();
});

function handleSwipe() {
    if (isMobile) {
        // Вертикальный свайп
        if (touchStartY - touchEndY > 50) { // Вверх
            navigateTo(currentSlide + 1, 'next');
        } else if (touchEndY - touchStartY > 50) { // Вниз
            navigateTo(currentSlide - 1, 'prev');
        }
    } else {
        // Горизонтальный свайп (бонус для трекпадов на ноутах)
        if (touchStartX - touchEndX > 50) { // Влево
            navigateTo(currentSlide + 1, 'next');
        } else if (touchEndX - touchStartX > 50) { // Вправо
            navigateTo(currentSlide - 1, 'prev');
        }
    }
}

// Кнопки и стрелки на клавиатуре
document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') navigateTo(currentSlide + 1, 'next');
    if (e.key === 'ArrowLeft') navigateTo(currentSlide - 1, 'prev');
});

document.getElementById('nextBtn').onclick = () => navigateTo(currentSlide + 1, 'next');
document.getElementById('prevBtn').onclick = () => navigateTo(currentSlide - 1, 'prev');

// Адаптация при изменении размера окна
window.addEventListener('resize', () => {
    isMobile = window.innerWidth <= 768;
    // Мгновенно переключаем layout без анимации, чтобы не было глитчей
    appContainer.style.transition = 'none'; 
    if (isMobile) {
        appContainer.style.flexDirection = 'column';
        appContainer.style.transform = `translateY(-${currentSlide * 100}vh)`;
    } else {
        appContainer.style.flexDirection = 'row';
        appContainer.style.transform = `translateX(-${currentSlide * 100}vw)`;
    }
    // Возвращаем анимацию
    setTimeout(() => {
        appContainer.style.transition = 'transform 0.8s cubic-bezier(0.86, 0, 0.07, 1)';
    }, 50);
});




async function renderApp() {
    // 1. ЕСЛИ ЭТО ЭКРАН ЗАГРУЗКИ (Слайд 0)
    if (currentSlide === 0) {
        // Тут мы чистим всё, так как это самое начало
        app.innerHTML = ''
        
        // Генерим HTML для нулевого слайда (Загрузка)
        // Оборачиваем в div class="slide", чтобы стили работали
        const slide0 = document.createElement('div');
        slide0.className = 'slide';
        slide0.innerHTML = `
            <div class="slide-content animate-pop">
                <h1 style="font-size:3.5rem; margin-bottom:1rem">Namida<br><span style="color:var(--accent-lime)">Wrapped</span></h1>
                
                <div class="file-input-wrapper">
                    <p class="text-sm text-gray-400 text-left mb-1 ml-1 font-bold">Drop your Backup Zip here 👇</p>
                    <input type="file" id="f1">
                </div>

                <button id="startBtn" class="btn-geo mt-4">Watch your wrapped</button>
                <button id="instrBtn" class="mt-6 text-gray-500 underline hover:text-[#d2fa39] transition text-sm font-bold cursor-pointer">How to get data? ℹ️</button>
                <p id="status" class="mt-4 text-sm text-gray-500"></p>

                <!-- МОДАЛКА -->
                <div id="instrModal" class="fixed inset-0 z-[100] hidden flex items-center justify-center p-4 backdrop-blur-sm">
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
        
        app.appendChild(slide0);

        // Вешаем слушатели для 0 слайда
        document.getElementById('startBtn').onclick = () => {
            const f1 = document.getElementById('f1').files[0];
            if(f1) processFiles(f1); // <-- Важно: processFiles должна в конце вызвать renderApp() с currentSlide = 1
            else alert("You've forgotten to upload your file.");
        };

        const modal = document.getElementById('instrModal');
        document.getElementById('instrBtn').onclick = () => modal.classList.remove('hidden');
        const closeModal = () => modal.classList.add('hidden');
        document.getElementById('closeInstr').onclick = closeModal;
        document.getElementById('closeInstrBtn').onclick = closeModal;

        return; // Выходим, дальше строить пока нечего
    }

    // 2. ЕСЛИ ДАННЫЕ ГОТОВЫ (Мы пришли сюда после processFiles)
    // Строим ВСЕ остальные слайды разом!
    
    app.innerHTML = ''; // Чистим экран загрузки
    
    // Показываем навигацию, если надо
    nav.classList.remove('hidden');

    // --- ГЕНЕРАТОР ВСЕХ СЛАЙДОВ ---
    // Мы бежим циклом от 1 до 19 и создаем каждый слайд
    for (let i = 1; i <= MAX_SLIDES; i++) {
        
        // Логика пропуска слайдов с жанрами (из твоего кода)
        // Если жанров мало, скипаем слайды 5 и 6 (индексы 4, 5, 6 в коде могут отличаться, подгони если что)
        // В твоем коде было: if (currentSlide === 4 && stats.totalGenres <= 5) currentSlide = 7;
        // Значит, если i == 4 и жанров мало, мы прыгаем сразу на 7? 
        // Давай сделаем так: если условие верно, просто continue для i=4, i=5, i=6
        if (i >= 4 && i < 7 && stats.totalGenres <= 5) continue;

        const slideDiv = document.createElement('div');
        slideDiv.className = 'slide'; // ВОТ ОНО! Делаем слайд блоком
        slideDiv.id = `slide-${i}`; // Для удобства отладки
        
        let html = '';

        // Твой огромный switch переезжает сюда
        switch(i) {
            case 1: 
                html = `<div class="slide-content animate-up"><h1 class="big-stat" style="font-size:3rem; color:white">HI THERE!</h1><p class="text-2xl">This is your Namida Wrapped ${new Date().getFullYear()}</p><p class="text-gray-500 mt-2">Are you ready?</p>
                <p class="text-xs text-gray-600 mt-4 desktop-only">(You can use arrow keys on your keyboard)</p>
                <p class="text-xs text-gray-600 mt-4 md:hidden">(Swipe to navigate)</p></div>`; 
                break;

            case 2: 
                html = `<div class="slide-content animate-up"><h2 class="text-3xl font-bold mb-4">You listened.<br>We counted.</h2><p class="text-gray-400 mb-4">Enter your nickname (for endcard)</p><input id="ni" type="text" class="bg-transparent border-b-2 border-white text-3xl w-full p-2 outline-none" placeholder="Name..." value="${userName}"></div>`; 
                break;
            
            case 3: 
                const days = (stats.totalMs / 1000 / 60 / 60 / 24).toFixed(1);
                html = `<div class="slide-content animate-up"><h1 class="big-stat">${Math.round(stats.totalMs/60000).toLocaleString()}</h1><p class="text-2xl font-bold">listening minutes.</p><div class="mt-6 p-4 bg-[#222] rounded-lg"><p>That's how long you've been listening to music this year.</p><p class="mt-2 text-gray-400"> ≈ <b class="text-white">${days} days</b>.</p><p class="mt-2 text-purple-400 font-bold">Awesome, isn't it? </p></div></div>`; 
                break;
            
            case 4: 
                html = `<div class="slide-content animate-up"><h2 class="text-4xl font-bold">How many<br>genres do you think you've listened to?</h2></div>`; 
                break;
            
            case 5: 
                const topG = stats.genres[0][0];
                const insult = topG.toLowerCase().includes('unknown') ? `<p class="text-red-400 mt-4 font-bold">Why didn't you fill genres on your songs tho? 🤡</p>` : '';
                html = `<div class="slide-content animate-pop"><h1 class="big-stat text-pink-500">${stats.totalGenres}</h1><p class="text-3xl font-bold">genres.</p><p class="text-xl mt-2">The perfect amount.</p>${insult}</div>`; 
                break;

            case 6: 
                const top5g = stats.genres.slice(0, 5).map(g => `<div style="background:white;color:black;display:inline-block;padding:4px 12px;margin:4px 0;font-weight:900;transform:rotate(-1deg);font-size:1.5rem">${g[0]}</div>`).join('');
                html = `<div class="slide-content animate-up"><h2 class="text-2xl text-gray-400 mb-6 font-bold">Your favourite genres</h2><div class="flex flex-col items-start">${top5g}</div></div>`; 
                break;

            case 7: 
                html = `<div class="slide-content animate-up"><p class="text-gray-400">You've listened to</p><h1 class="big-stat text-white my-2">${stats.totalTracks}</h1><p class="text-gray-400">songs this year.</p><p class="mt-6 text-2xl font-bold">But can you guess #1 song?</p></div>`; 
                break;
            
            case 8: // Guess
                const correctT = stats.tracks[0];
                const opts = [...stats.tracks.slice(0, 5)].sort(()=>Math.random()-0.5);
                
                // Сохраняем правильный ответ текстом в атрибут самой кнопки, чтобы не потерять
                const htmlOpts = opts.map(t => {
                    const isCorr = (t.path === correctT.path);
                    return `<button class="guess-btn" 
                        data-correct="${isCorr}" 
                        data-real-title="${correctT.meta.title}" 
                        data-real-artist="${correctT.meta.artist}">
                        <div class="font-bold">${t.meta.title}</div>
                        <div class="text-xs text-gray-400">${t.meta.artist}</div>
                    </button>`;
                }).join('');

                html = `<div class="slide-content animate-up"><h2 class="text-2xl font-bold mb-4">Make your pick.</h2>${htmlOpts}<p id="res" class="mt-4 font-bold min-h-[20px]"></p></div>`;
                break;

            case 9: 
                const bt = stats.tracks[0];
                const bi = await fetchImage(bt.meta.artist, bt.meta.album);
                html = `<div class="slide-content animate-pop"><p class="text-gray-400 uppercase font-bold mb-2">Your favourite song</p>${bi?`<img src="${bi}" class="w-64 h-64 shadow-2xl mb-6 rounded-lg">`:''}<h1 class="text-3xl font-black mb-2">${bt.meta.title}</h1><p class="text-xl text-gray-300">by ${bt.meta.artist}</p><div class="mt-4 bg-white text-black px-3 py-1 inline-block font-bold">You've listened to it ${bt.count} times. Great song!</div></div>`;
                break;

            case 10: 
                const listT = await getImagesForList(stats.tracks.slice(0, 5), true);
                const htmlListT = listT.map((t, ind) => `
                <div class="flex items-center gap-4 mb-4">
                    <div class="text-2xl font-black text-gray-600 w-6 text-center">${ind+1}</div>
                    <div class="w-12 h-12 rounded bg-gray-800 overflow-hidden flex-shrink-0">${t.img?`<img src="${t.img}" class="w-full h-full object-cover">`:t.placeholderHTML||''}</div>
                    <div class="overflow-hidden"><div class="font-bold truncate">${t.meta.title}</div><div class="text-xs text-gray-400 truncate">${t.meta.artist}</div></div>
                </div>`).join('');
                html = `<div class="slide-content animate-up"><h2 class="text-3xl font-bold mb-6">Your favourite songs</h2>${htmlListT}</div>`;
                break;
            
            case 11: 
                const td = stats.topDay;
                const options = { month: 'long', day: 'numeric' };
                const dateStr = td ? td.dateObj.toLocaleDateString('en-US', options) : 'Someday';
                html = `
                    <div class="slide-content animate-pop">
                        <h2 class="text-3xl font-bold mb-2">On <span class="text-[#d2fa39]">${dateStr}</span></h2>
                        <h2 class="text-2xl font-bold">you listened to the most tracks.</h2>
                        <div class="mt-8 text-6xl">📅</div>
                        <p class="text-gray-400 mt-8">It was quite a busy day for your ears.</p>
                    </div>`;
                break;

            case 12: 
                const td2 = stats.topDay;
                if (!td2) {
                    html = `<div class="slide-content animate-up"><h2>No data available :(</h2></div>`;
                } else {
                    const dayMins = Math.round(td2.ms / 60000);
                    html = `
                        <div class="slide-content animate-up">
                            <p class="text-gray-400 text-xl font-bold mb-4">You've listened to</p>
                            <h1 class="big-stat text-cyan-400" style="font-size: 6rem; line-height:1">${td2.count}</h1>
                            <p class="text-2xl font-bold mb-8">tracks.</p>
                            
                            <p class="text-gray-400 text-xl font-bold">Totaling</p>
                            <h1 class="big-stat text-pink-400" style="font-size: 5rem; line-height:1">${dayMins}</h1>
                            <p class="text-2xl font-bold">minutes.</p>
                            
                            <p class="text-gray-500 text-sm mt-8 font-bold uppercase tracking-widest">Cool.</p>
                        </div>`;
                }
                break;

            case 13: 
                html = `<div class="slide-content animate-up"><p>You've listened to</p><h1 class="big-stat text-purple-400 my-2">${stats.totalAlbums}</h1><p>albums this year</p></div>`; 
                break;
            
            case 14: 
                const ba = stats.albums[0];
                const bai = await fetchImage(ba.artist, ba.name);
                html = `<div class="slide-content animate-pop"><p class="text-gray-400 uppercase font-bold mb-2">Your most listened album</p>${bai?`<img src="${bai}" class="w-64 h-64 shadow-2xl mb-6 rounded">`:''}<h2 class="text-2xl font-black">${ba.name}</h2><p class="text-xl text-gray-300">by ${ba.artist}</p><p class="mt-4 text-gray-500">You've listened to it for <b class="text-white">${formatTime(ba.ms)}</b> minutes. Impressive.</p></div>`;
                break;

            case 15: 
                const albumsGrid = await Promise.all(stats.albums.slice(0, 5).map(async a => ({...a, img: await fetchImage(a.artist, a.name)})));
                let gridHTML = `<div class="album-grid-container">`;
                albumsGrid.forEach((a, idx) => {
                    const content = a.img ? `<img src="${a.img}">` : `<div class="w-full h-full bg-gray-800 flex items-center justify-center text-2xl font-bold">${a.name[0]}</div>`;
                    gridHTML += `<div class="grid-item grid-pos-${idx+1}">${content}<div class="grid-rank">${idx+1}</div></div>`;
                });
                gridHTML += `</div><div class="album-text-list">`;
                albumsGrid.forEach((a, idx) => {
                    gridHTML += `<div class="album-text-row"><div class="album-text-rank">${idx+1}</div><div class="album-text-info"><div class="album-text-name">${a.name}</div><div class="album-text-art">${a.artist}</div></div></div>`;
                });
                gridHTML += `</div>`;
                html = `<div class="slide-content animate-up"><h2 class="text-2xl font-bold text-[#d2fa39] px-2">Your top albums</h2>${gridHTML}</div>`;
                break;

            case 16: 
                const insane = stats.totalArtists > 150 ? `<p class="text-red-500 font-bold mt-4 animate-pulse">That's lowkey impressive!</p>` : '';
                html = `<div class="slide-content animate-up"><p>You've listened to</p><h1 class="big-stat text-green-400 my-2">${stats.totalArtists}</h1><p>artists this year.</p>${insane}</div>`; 
                break;

            case 17: 
                const bArt = stats.artists[0];
                const bArtImg = await fetchImage(bArt.name);
                const cool = formatTime(bArt.ms) > 3000 ? `<p class="text-purple-400 font-bold mt-4">Ебать ты крут 🔥</p>` : '';
                html = `<div class="slide-content animate-pop"><p class="text-gray-400">Your number one artist was</p>${bArtImg?`<img src="${bArtImg}" class="w-56 h-56 rounded-full border-4 border-lime-400 my-6 object-cover shadow-2xl">`:''}<h1 class="text-4xl font-black uppercase">${bArt.name}</h1><p class="mt-2">You've listened to them for <b class="text-lime-400 text-xl">${formatTime(bArt.ms)}</b> minutes.</p>${cool}</div>`;
                break;

            case 18: 
                const listA = await getImagesForList(stats.artists.slice(0, 5), false);
                const htmlListA = listA.map((a, ind) => `
                <div class="flex items-center gap-4 mb-4">
                    <div class="text-2xl font-black text-gray-600 w-6 text-center">${ind+1}</div>
                    <div class="w-12 h-12 rounded-full bg-gray-800 overflow-hidden flex-shrink-0">${a.img?`<img src="${a.img}" class="w-full h-full object-cover">`:a.placeholderHTML||''}</div>
                    <div class="font-bold text-lg">${a.name}</div>
                </div>`).join('');
                html = `<div class="slide-content animate-up"><h2 class="text-3xl font-bold mb-8">Your favourite artists</h2>${htmlListA}</div>`;
                break;

            case 19: 
                const topArtHero = await fetchImage(stats.artists[0].name);
                const heroBg = topArtHero ? `url(${topArtHero})` : 'linear-gradient(45deg, #333, #111)';
                const rowStyle = "font-size: 0.75rem; font-weight: 700; margin-bottom: 2px; white-space: nowrap; line-height: 1.2; color: black;";
                const colArt = stats.artists.slice(0,5).map((a,ind)=> `<div style="${rowStyle}">${ind+1} ${cutText(a.name, 25)}</div>`).join('');
                const colTrk = stats.tracks.slice(0,5).map((t,ind)=> `<div style="${rowStyle}">${ind+1} ${cutText(t.meta.title, 25)}</div>`).join('');
                
                let finalGenre = stats.genres[0][0];
                if ((finalGenre.toLowerCase().includes('unknown')) && stats.genres[1]) finalGenre = stats.genres[1][0];

                html = `
                <div class="slide-content animate-pop" style="padding:0; justify-content:center; align-items:center; height: auto; min-height: 100vh;">
                    <div id="finalCard" class="summary-card">
                        <div style="height:280px; width:100%; background:${heroBg} center/cover; filter:grayscale(100%) contrast(110%); position:absolute; top:0; left:0;"></div>
                        <div style="height:281px; width:100%; background:linear-gradient(to bottom, transparent 20%, #F2F0E9 95%); position:absolute; top:0; left:0;"></div>
                        <div style="position:relative; z-index:2; margin-top:180px;">
                            <h1 style="font-size:4rem; line-height:0.8; color:black; margin-bottom:20px; letter-spacing: -2px;">WRAPPED<br><span style="color:#d2fa39; -webkit-text-stroke:1.5px black;">${new Date().getFullYear()}</span></h1>
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:20px; margin-bottom: 25px;">
                                <div><h3 style="border-bottom:3px solid black; font-size:0.9rem; margin-bottom:8px; padding-bottom:2px;">TOP ARTISTS</h3>${colArt}</div>
                                <div><h3 style="border-bottom:3px solid black; font-size:0.9rem; margin-bottom:8px; padding-bottom:2px;">TOP SONGS</h3>${colTrk}</div>
                            </div>
                            <div style="margin-top:20px; display:flex; justify-content:space-between; align-items:end; border-top: 2px solid #ddd; padding-top: 15px;">
                                <div><div style="font-size:0.6rem; font-weight:900; color:#666; text-transform: uppercase;">Minutes Listened</div><div style="font-size:1.8rem; font-weight:900; line-height: 1;">${Math.round(stats.totalMs/60000).toLocaleString()}</div></div>
                                <div style="text-align:right"><div style="font-size:0.6rem; font-weight:900; color:#666; text-transform: uppercase;">Top Genre</div><div style="background:black; color:#d2fa39; padding:2px 8px; font-weight:900; display:inline-block; transform:rotate(-2deg); font-size: 1.1rem;">${finalGenre}</div></div>
                            </div>
                            <div style="margin-top: 20px; display:flex; justify-content:space-between; align-items:center;">
                                <div style="font-family: monospace; font-size: 0.7rem; color: #888;">namida-wrapped.vercel.app</div>
                                <div id="finalName" style="font-weight: 900; font-size: 1rem; text-transform: uppercase; color: black;">${userName || 'Music Lover'}</div>
                            </div>
                         </div>
                    </div>
                    <div class="flex gap-4 mt-8 w-full max-w-[450px]">
                        <button onclick="location.reload()" class="btn-geo text-sm py-3 flex-1" style="background:#333; color:white;">REPLAY ↺</button>
                        <button onclick="saveCard()" class="btn-geo text-sm py-3 flex-1">SAVE IMAGE ⬇</button>
                    </div>
                </div>`;
                break;
        }

        // Вставляем сгенерированный HTML внутрь нашего div.slide
        slideDiv.innerHTML = html;
        // Добавляем этот слайд в общий контейнер
        app.appendChild(slideDiv);

        // --- ПОСТ-ОБРАБОТКА (Слушатели событий) ---
        // Так как мы только что создали элементы, слушатели вешаем сразу же
        // Пост-обработка (после app.appendChild(slideDiv)):
        if (i === 2) {
            const nameInput = slideDiv.querySelector('#ni');
            // На всякий случай, если userName уже был задан ранее
            if(userName) nameInput.value = userName;
            
            nameInput.addEventListener('input', (e) => {
                // 1. Обновляем переменную
                userName = e.target.value;
                
                // 2. Ищем элемент на последнем слайде (он уже существует в DOM!)
                const finalNameEl = document.getElementById('finalName');
                if (finalNameEl) {
                    finalNameEl.innerText = userName || 'MUSIC LOVER';
                }
            });
        }

        // НОВЫЙ КОД ДЛЯ СЛАЙДА 8:
        if (i === 8) {
            const guessButtons = slideDiv.querySelectorAll('.guess-btn');
            guessButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const isCorrect = (btn.getAttribute('data-correct') === 'true');
                    const realTitle = btn.getAttribute('data-real-title');
                    const realArtist = btn.getAttribute('data-real-artist');
                    
                    guessButtons.forEach(b => b.disabled = true);
                    
                    const resElement = slideDiv.querySelector('#res');
                    
                    if (isCorrect) {
                        btn.classList.add('guess-correct');
                        resElement.innerText = "You got it!";
                        resElement.style.color = "#d2fa39";
                    } else {
                        btn.classList.add('guess-wrong');
                        // Берем текст из атрибутов кнопки, так надежнее всего
                        resElement.innerText = `No, it actually was ${realTitle} by ${realArtist}`;
                        resElement.style.color = "#ff4444";
                    }
                });
            });
        }
        if (i === 19) {
            window.saveCard = () => {
                const card = document.getElementById('finalCard');
                const btn = document.querySelector('button[onclick="saveCard()"]');
                const oldText = btn.innerText;
                btn.innerText = "COOKING... 🍳";
                htmlToImage.toPng(card, { quality: 1.0, pixelRatio: 3, backgroundColor: '#F2F0E9' })
                .then(function (dataUrl) {
                    const link = document.createElement('a');
                    link.download = `Namida_Wrapped_${new Date().getFullYear()}_${userName}.png`;
                    link.href = dataUrl;
                    link.click();
                    btn.innerText = "SAVED! 🔥";
                    setTimeout(()=> btn.innerText = oldText, 2000);
                })
                .catch(function (error) {
                    console.error('oops', error);
                    btn.innerText = "ERROR 💀";
                    alert("Couldn't render. Screenshot it.");
                });
            };
        }
    }
    // 1. Обновляем переменную
    currentSlide = 0; 

    // 2. Форсируем прыжок в начало
    navigateTo(0, 'initial');
}
function cutText(str, len = 22) {
    if (!str) return "";
    if (str.length > len) {
        return str.substring(0, len).trim() + "...";
    }
    return str;
}

renderApp();
