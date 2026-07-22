const API_ROOT = 'https://www.googleapis.com/youtube/v3';
const EXPECTED_HANDLE = process.env.YOUTUBE_HANDLE || '@sk_ashais';

export default async () => {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY || '';
    if (!apiKey) throw new Error('Netlify nav iestatīts YOUTUBE_API_KEY.');

    const channel = await fetchChannel(apiKey);
    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) throw new Error('Kanāla augšupielāžu saraksts nav atrasts.');

    const [uploadItems, playlists] = await Promise.all([
      fetchAllPlaylistItems(uploadsPlaylistId, apiKey),
      fetchChannelPlaylists(channel.id, apiKey),
    ]);

    const records = new Map();

    // SVARĪGI: uploads playlistes item.snippet.publishedAt ir datums,
    // kad video tika pievienots kanāla augšupielāžu sarakstam. Tas saglabā
    // arhīva hronoloģiju arī tad, ja vecs nerindots video šodien kļūst publisks.
    mergeUploadItems(records, uploadItems);

    // Shorts paliek atsevišķā plūsmā. Ja kanālā ir publiska playliste ar
    // nosaukumu “Shorts”, tās saturs vienmēr tiek atzīts par Shorts.
    const shortsPlaylists = playlists.filter((playlist) => isShortsPlaylist(playlist.snippet?.title || ''));
    await Promise.all(shortsPlaylists.map(async (playlist) => {
      const items = await fetchAllPlaylistItems(playlist.id, apiKey);
      markShorts(records, items);
    }));

    const ids = [...records.keys()];
    const metadata = await fetchVideoMetadata(ids, apiKey);

    const all = ids
      .map((id) => buildVideo(records.get(id), metadata.get(id)))
      .filter(Boolean)
      .sort((a, b) => dateValue(b.archiveDate) - dateValue(a.archiveDate));

    const shorts = all.filter((video) => video.isShort);
    const videos = all.filter((video) => !video.isShort);
    const featuredId = process.env.FEATURED_VIDEO_ID || '';
    const featured = videos.find((video) => video.id === featuredId) || videos[0] || null;

    return json({
      generatedAt: new Date().toISOString(),
      mode: 'uploads-original-date',
      channel: {
        id: channel.id,
        title: channel.snippet?.title || 'SPORTA KLUBS AŠAIS',
        handle: channel.snippet?.customUrl || EXPECTED_HANDLE,
      },
      counts: { videos: videos.length, shorts: shorts.length, total: all.length },
      featured,
      videos,
      shorts,
    }, 200);
  } catch (error) {
    console.error('youtube-videos:', error);
    return json({ error: error.message || 'YouTube datu ielāde neizdevās.' }, 502, 'no-store');
  }
};

async function fetchChannel(apiKey) {
  const data = await youtube('/channels', {
    part: 'snippet,contentDetails',
    forHandle: EXPECTED_HANDLE,
    maxResults: '1',
  }, apiKey);
  const channel = data.items?.[0];
  if (!channel) throw new Error(`YouTube kanāls ${EXPECTED_HANDLE} nav atrasts.`);
  return channel;
}

async function fetchChannelPlaylists(channelId, apiKey) {
  const playlists = [];
  let pageToken = '';
  do {
    const data = await youtube('/playlists', {
      part: 'snippet',
      channelId,
      maxResults: '50',
      pageToken,
    }, apiKey);
    playlists.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return playlists;
}

async function fetchAllPlaylistItems(playlistId, apiKey) {
  const items = [];
  let pageToken = '';
  do {
    const data = await youtube('/playlistItems', {
      part: 'snippet,contentDetails,status',
      playlistId,
      maxResults: '50',
      pageToken,
    }, apiKey);
    items.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return items;
}

function mergeUploadItems(records, items) {
  for (const item of items) {
    const id = videoIdFromItem(item);
    const title = item.snippet?.title || '';
    if (!id || !title || title === 'Deleted video' || title === 'Private video') continue;

    records.set(id, {
      id,
      title,
      description: item.snippet?.description || '',
      thumbnail: bestThumbnail(item.snippet?.thumbnails),
      // Šis ir arhīva kārtošanas datums — nevis šodienas “Public” datums.
      uploadedAt: item.snippet?.publishedAt || '',
      youtubePublishedAt: item.contentDetails?.videoPublishedAt || '',
      uploadPosition: Number.isFinite(item.snippet?.position) ? item.snippet.position : Number.MAX_SAFE_INTEGER,
      isShort: false,
    });
  }
}

function markShorts(records, items) {
  for (const item of items) {
    const id = videoIdFromItem(item);
    if (id && records.has(id)) records.get(id).isShort = true;
  }
}

async function fetchVideoMetadata(ids, apiKey) {
  const map = new Map();
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const data = await youtube('/videos', {
      part: 'snippet,contentDetails,status',
      id: batch.join(','),
      maxResults: '50',
    }, apiKey);
    for (const item of data.items || []) {
      map.set(item.id, {
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        thumbnail: bestThumbnail(item.snippet?.thumbnails),
        youtubePublishedAt: item.snippet?.publishedAt || '',
        durationSeconds: isoDurationToSeconds(item.contentDetails?.duration),
        privacyStatus: item.status?.privacyStatus || '',
      });
    }
  }
  return map;
}

function buildVideo(record, metadata) {
  if (!record) return null;
  if (metadata?.privacyStatus === 'private') return null;

  const title = metadata?.title || record.title || '';
  if (!title || title === 'Deleted video' || title === 'Private video') return null;

  const description = metadata?.description || record.description || '';
  const explicitShort = /(^|[\s#])shorts?([\s#]|$)/i.test(`${title} ${description}`);
  const isShort = record.isShort || explicitShort;

  // Galvenā izmaiņa: arhīvā un uz kartītēm izmantojam sākotnējo uploads
  // playlistes datumu. YouTube publiskošanas datumu glabājam tikai diagnostikai.
  const archiveDate = record.uploadedAt || metadata?.youtubePublishedAt || record.youtubePublishedAt || '';
  const year = archiveDate ? new Date(archiveDate).getUTCFullYear() : '';

  return {
    id: record.id,
    title,
    description: firstUsefulSentence(description),
    thumbnail: metadata?.thumbnail || record.thumbnail || `https://i.ytimg.com/vi/${record.id}/hqdefault.jpg`,
    archiveDate,
    publishedAt: archiveDate,
    youtubePublishedAt: metadata?.youtubePublishedAt || record.youtubePublishedAt || '',
    year,
    durationSeconds: metadata?.durationSeconds || 0,
    isShort,
    searchText: `${title} ${description}`,
  };
}

function isShortsPlaylist(title) {
  const value = normalize(title);
  return /(^|\s)(shorts?|isie|isie klipi)(\s|$)/.test(value);
}

function normalize(value = '') {
  return String(value)
    .toLocaleLowerCase('lv-LV')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function dateValue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function videoIdFromItem(item) {
  return item.contentDetails?.videoId || item.snippet?.resourceId?.videoId || '';
}

function bestThumbnail(thumbnails = {}) {
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '';
}

function firstUsefulSentence(description = '') {
  const line = String(description)
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part && !/^https?:\/\//i.test(part) && !/^#/.test(part));
  if (!line) return '';
  return line.length > 170 ? `${line.slice(0, 167).trim()}…` : line;
}

function isoDurationToSeconds(value = '') {
  const match = String(value).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

async function youtube(path, params, apiKey) {
  const url = new URL(`${API_ROOT}${path}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  url.searchParams.set('key', apiKey);

  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `YouTube API kļūda (${response.status})`;
    throw new Error(message);
  }
  return data;
}

function json(body, status = 200, cacheControl = 'public, max-age=60, s-maxage=120, stale-while-revalidate=300') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });
}
