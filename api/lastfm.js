// api/lastfm.js
export default async function handler(req, res) {
  const api_key = process.env.LASTFM_API_KEY;

  if (!api_key) {
    return res.status(500).json({ error: 'LastFM Key missing on server' });
  }

  // Вытаскиваем параметры, которые прислал фронтенд
  const { method, artist, album } = req.query;

  if (!method || !artist) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  try {
    // Собираем URL для запроса к Last.fm
    let url = `https://ws.audioscrobbler.com/2.0/?api_key=${api_key}&format=json&autocorrect=1&method=${method}&artist=${encodeURIComponent(artist)}`;
    
    if (album) {
      url += `&album=${encodeURIComponent(album)}`;
    }

    // Делаем запрос с сервера Vercel к Last.fm
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'NamidaWrapped/1.0'
        }
    });
    
    const data = await response.json();
    
    // Отдаем результат фронту
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch from LastFM' });
  }
}
