const API_ROOT = 'https://www.googleapis.com/youtube/v3';
const EXPECTED_HANDLE = process.env.YOUTUBE_HANDLE || '@sk_ashais';

const CATEGORY_ORDER = ['Sacensības', 'Treniņi', 'Nometnes', 'Intervijas', 'Kluba dzīve', 'Citi'];

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

    // Publiskie video — lai arhīvs nav tukšs arī pirms visu playlisšu sakārtošanas.
    mergePlaylistItems(records, uploadItems, { category: 'Citi', isShort: false, source: 'uploads' });

    const recognisedPlaylists = playlists
      .map((playlist) => ({
        id: playlist.id,
        title: playlist.snippet?.title || '',
        classification: classifyPlaylist(playlist.snippet?.title || ''),
      }))
      .filter((playlist) => playlist.classification);

    // Playlists ir vienīgais kategoriju avots. Nekādas minēšanas pēc video teksta.
    await Promise.all(recognisedPlaylists.map(async (playlist) => {
      const items = await fetchAllPlaylistItems(playlist.id, apiKey);
      mergePlaylistItems(records, items, {
        category: playlist.classification.category,
        isShort: playlist.classification.isShort,
        source: playlist.title,
      });
    }));

    const ids = [...records.keys()];
    const metadata = await fetchVideoMetadata(ids, apiKey);

    const all = ids
      .map((id) => buildVideo(records.get(id), metadata.get(id)))
      .filter(Boolean)
      .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

    const shorts = all.filter((video) => video.isShort);
    const videos = all.filter((video) => !video.isShort);
    const featuredId = process.env.FEATURED_VIDEO_ID || '';
    const featured = videos.find((video) => video.id === featuredId) || videos[0] || null;

    const foundCategories = new Set(videos.flatMap((video) => video.categories || []));
    const missingPlaylists = ['Sacensības', 'Treniņi', 'Nometnes', 'Intervijas', 'Kluba dzīve', 'Shorts']
      .filter((name) => name === 'Shorts'
        ? !recognisedPlaylists.some((p) => p.classification.isShort)
        : !recognisedPlaylists.some((p) => p.classification.category === name));

    return json({
      generatedAt: new Date().toISOString(),
      mode: 'playlists',
      channel: {
        id: channel.id,
        title: channel.snippet?.title || 'SPORTA KLUBS AŠAIS',
        handle: channel.snippet?.customUrl || EXPECTED_HANDLE,
      },
      counts: { videos: videos.length, shorts: shorts.length, total: all.length },
      categories: CATEGORY_ORDER.filter((category) => foundCategories.has(category)),
      missingPlaylists,
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
      part: 'snippet,status,contentDetails',
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

function mergePlaylistItems(records, items, classification) {
  for (const item of items) {
    const id = videoIdFromItem(item);
    const title = item.snippet?.title || '';
    if (!id || !title || title === 'Deleted video' || title === 'Private video') continue;

    const current = records.get(id) || {
      id,
      title,
      description: item.snippet?.description || '',
      thumbnail: bestThumbnail(item.snippet?.thumbnails),
      publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '',
      categories: new Set(),
      isShort: false,
      sources: new Set(),
    };

    if (!current.title && title) current.title = title;
    if (!current.description && item.snippet?.description) current.description = item.snippet.description;
    if (!current.thumbnail) current.thumbnail = bestThumbnail(item.snippet?.thumbnails);
    if (!current.publishedAt) current.publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || '';

    if (classification.isShort) {
      current.isShort = true;
      current.categories.delete('Citi');
    } else if (!current.isShort && classification.category) {
      if (classification.category !== 'Citi') current.categories.delete('Citi');
      current.categories.add(classification.category);
    }
    current.sources.add(classification.source);
    records.set(id, current);
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
        publishedAt: item.snippet?.publishedAt || '',
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

  // Shorts playlist wins. Optional fallback catches only explicitly tagged Shorts.
  const explicitShort = /(^|[\s#])shorts?([\s#]|$)/i.test(`${title} ${metadata?.description || record.description || ''}`);
  const isShort = record.isShort || explicitShort;

  const categories = [...record.categories];
  if (!isShort && categories.length === 0) categories.push('Citi');
  categories.sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));

  const publishedAt = metadata?.publishedAt || record.publishedAt || '';
  const year = publishedAt ? new Date(publishedAt).getUTCFullYear() : '';
  const description = metadata?.description || record.description || '';

  return {
    id: record.id,
    title,
    description: firstUsefulSentence(description),
    thumbnail: metadata?.thumbnail || record.thumbnail || `https://i.ytimg.com/vi/${record.id}/hqdefault.jpg`,
    publishedAt,
    year,
    durationSeconds: metadata?.durationSeconds || 0,
    isShort,
    categories: isShort ? [] : categories,
    category: isShort ? 'Shorts' : (categories[0] || 'Citi'),
    searchText: `${title} ${description} ${categories.join(' ')}`,
  };
}

function classifyPlaylist(title) {
  const value = normalize(title);
  if (/\b(shorts?|isie|isie klipi)\b/.test(value)) return { isShort: true, category: 'Shorts' };
  if (/sacens|mac[iī]|čempionat|kauss|skrējiens|stadion/.test(value)) return { isShort: false, category: 'Sacensības' };
  if (/treni|workout|interval/.test(value)) return { isShort: false, category: 'Treniņi' };
  if (/nometn|camp/.test(value)) return { isShort: false, category: 'Nometnes' };
  if (/interv|sarun|podkast/.test(value)) return { isShort: false, category: 'Intervijas' };
  if (/kluba dzive|aso dzive|komanda|pasakum|aizkul/.test(value)) return { isShort: false, category: 'Kluba dzīve' };
  if (/\bciti\b|arhivs/.test(value)) return { isShort: false, category: 'Citi' };
  return null;
}

function normalize(value = '') {
  return String(value)
    .toLocaleLowerCase('lv-LV')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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

function json(body, status = 200, cacheControl = 'public, max-age=120, s-maxage=300, stale-while-revalidate=900') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });
}
