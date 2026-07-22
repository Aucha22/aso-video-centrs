const API_ROOT = 'https://www.googleapis.com/youtube/v3';
const EXPECTED_HANDLE = process.env.YOUTUBE_HANDLE || '@sk_ashais';
const CURRENT_YEAR = new Date().getUTCFullYear();

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
    mergeUploadItems(records, uploadItems);

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
      .sort(compareVideos);

    const shorts = all.filter((video) => video.isShort);
    const videos = all.filter((video) => !video.isShort);
    const featuredId = process.env.FEATURED_VIDEO_ID || '';
    const featured = videos.find((video) => video.id === featuredId) || videos[0] || null;

    return json({
      generatedAt: new Date().toISOString(),
      build: 'DATUMS-FIX-3',
      mode: 'text-inferred-archive-date',
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
      playlistPublishedAt: item.snippet?.publishedAt || '',
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
        tags: item.snippet?.tags || [],
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
  const tags = Array.isArray(metadata?.tags) ? metadata.tags.join(' ') : '';
  const explicitShort = /(^|[\s#])shorts?([\s#]|$)/i.test(`${title} ${description} ${tags}`);
  const isShort = record.isShort || explicitShort;

  const publicDate = metadata?.youtubePublishedAt || record.youtubePublishedAt || record.playlistPublishedAt || '';
  const inferred = inferArchiveDate({
    title,
    description,
    publicDate,
    uploadPosition: record.uploadPosition,
  });

  return {
    id: record.id,
    title,
    description: firstUsefulSentence(description),
    thumbnail: metadata?.thumbnail || record.thumbnail || `https://i.ytimg.com/vi/${record.id}/hqdefault.jpg`,
    archiveDate: inferred.iso,
    publishedAt: inferred.iso,
    youtubePublishedAt: publicDate,
    datePrecision: inferred.precision,
    dateSource: inferred.source,
    year: inferred.year,
    sortTimestamp: inferred.sortTimestamp,
    uploadPosition: record.uploadPosition,
    durationSeconds: metadata?.durationSeconds || 0,
    isShort,
    searchText: `${title} ${description} ${tags}`,
  };
}

function compareVideos(a, b) {
  const dateDifference = Number(b.sortTimestamp || 0) - Number(a.sortTimestamp || 0);
  if (dateDifference !== 0) return dateDifference;
  const positionDifference = Number(a.uploadPosition ?? Number.MAX_SAFE_INTEGER) - Number(b.uploadPosition ?? Number.MAX_SAFE_INTEGER);
  if (positionDifference !== 0) return positionDifference;
  return String(a.title || '').localeCompare(String(b.title || ''), 'lv');
}

/**
 * YouTube veciem nerindotiem video, kurus padara publiskus, var atdot jauno
 * publiskošanas datumu. Tāpēc arhīva datumu vispirms mēģinām nolasīt no
 * nosaukuma un apraksta. Nosaukums vienmēr ir prioritārs.
 */
export function inferArchiveDate({ title = '', description = '', publicDate = '', uploadPosition = 0 } = {}) {
  const safeTitle = String(title);
  const safeDescription = String(description).slice(0, 1200);
  const publicTimestamp = dateValue(publicDate);
  const publicYear = publicTimestamp ? new Date(publicTimestamp).getUTCFullYear() : 0;

  const titleYear = extractYear(safeTitle);
  const descriptionYear = extractYear(safeDescription);
  const preferredYear = titleYear || descriptionYear || publicYear || CURRENT_YEAR;

  const exactFromTitle = extractExactDate(safeTitle, preferredYear);
  if (exactFromTitle) return buildDateResult(exactFromTitle, 'day', 'title-exact', uploadPosition);

  const exactFromDescription = extractExactDate(safeDescription, preferredYear);
  if (exactFromDescription) return buildDateResult(exactFromDescription, 'day', 'description-exact', uploadPosition);

  const partialFromTitle = extractDayMonth(safeTitle);
  if (partialFromTitle && preferredYear) {
    const date = validUtcDate(preferredYear, partialFromTitle.month, partialFromTitle.day);
    if (date) return buildDateResult(date, 'day', 'title-day-month', uploadPosition);
  }

  const partialFromDescription = extractDayMonth(safeDescription);
  if (partialFromDescription && preferredYear) {
    const date = validUtcDate(preferredYear, partialFromDescription.month, partialFromDescription.day);
    if (date) return buildDateResult(date, 'day', 'description-day-month', uploadPosition);
  }

  // Gads nosaukumā ir pietiekams, lai 2024. gada video vairs nestāvētu pie
  // 2026. gada jaunumiem. Ja nosaukumā ir tas pats gads, kas publiskošanas
  // datumā, saglabājam precīzo YouTube datumu, jo tas var būt patiesi jauns video.
  if (titleYear && titleYear !== publicYear) {
    return buildYearResult(titleYear, 'title-year', uploadPosition);
  }

  if (!titleYear && descriptionYear && descriptionYear !== publicYear) {
    return buildYearResult(descriptionYear, 'description-year', uploadPosition);
  }

  if (publicTimestamp) {
    return {
      iso: new Date(publicTimestamp).toISOString(),
      year: publicYear,
      precision: 'day',
      source: 'youtube-public-date',
      sortTimestamp: publicTimestamp,
    };
  }

  const fallbackYear = titleYear || descriptionYear || CURRENT_YEAR;
  return buildYearResult(fallbackYear, 'fallback-year', uploadPosition);
}

function extractExactDate(value, fallbackYear) {
  const text = normalizeForDate(value);

  // 2024-07-06, 2024.07.06, 2024/07/06
  let match = text.match(/\b(20\d{2})\s*[.\/-]\s*(0?[1-9]|1[0-2])\s*[.\/-]\s*(0?[1-9]|[12]\d|3[01])\b/);
  if (match) return validUtcDate(Number(match[1]), Number(match[2]), Number(match[3]));

  // 06.07.2024, 6/7/2024, 06-07-24
  match = text.match(/\b(0?[1-9]|[12]\d|3[01])\s*[.\/-]\s*(0?[1-9]|1[0-2])\s*[.\/-]\s*((?:20)?\d{2})\b/);
  if (match) {
    const year = normalizeYear(Number(match[3]));
    return validUtcDate(year, Number(match[2]), Number(match[1]));
  }

  // 2024. gada 6. jūlijā / 2024 gada 6 julija
  match = text.match(/\b(20\d{2})\s*\.?\s*gada\s+(0?[1-9]|[12]\d|3[01])\s*\.?\s+([a-z]+)\b/);
  if (match) {
    const month = monthNumber(match[3]);
    if (month) return validUtcDate(Number(match[1]), month, Number(match[2]));
  }

  // 6. jūlijā 2024 / 6 July 2024
  match = text.match(/\b(0?[1-9]|[12]\d|3[01])\s*\.?\s+([a-z]+)\s*,?\s*(20\d{2})\b/);
  if (match) {
    const month = monthNumber(match[2]);
    if (month) return validUtcDate(Number(match[3]), month, Number(match[1]));
  }

  // July 6, 2024
  match = text.match(/\b([a-z]+)\s+(0?[1-9]|[12]\d|3[01])\s*,?\s*(20\d{2})\b/);
  if (match) {
    const month = monthNumber(match[1]);
    if (month) return validUtcDate(Number(match[3]), month, Number(match[2]));
  }

  // Ja ir zināms gads no nosaukuma, izmantojam aprakstā esošo “6. jūlijā”.
  const partial = extractDayMonth(text);
  if (partial && fallbackYear) return validUtcDate(fallbackYear, partial.month, partial.day);

  return null;
}

function extractDayMonth(value) {
  const text = normalizeForDate(value);
  let match = text.match(/\b(0?[1-9]|[12]\d|3[01])\s*\.?\s+([a-z]+)\b/);
  if (match) {
    const month = monthNumber(match[2]);
    if (month) return { day: Number(match[1]), month };
  }

  match = text.match(/\b([a-z]+)\s+(0?[1-9]|[12]\d|3[01])\b/);
  if (match) {
    const month = monthNumber(match[1]);
    if (month) return { day: Number(match[2]), month };
  }

  return null;
}

function extractYear(value) {
  const matches = String(value).match(/\b20\d{2}\b/g) || [];
  for (const candidate of matches) {
    const year = Number(candidate);
    if (year >= 2000 && year <= CURRENT_YEAR + 1) return year;
  }
  return 0;
}

function normalizeForDate(value = '') {
  return String(value)
    .toLocaleLowerCase('lv-LV')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”„‟«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function monthNumber(word = '') {
  const value = normalizeForDate(word);
  const prefixes = [
    ['janvar', 1], ['january', 1], ['jan', 1],
    ['februar', 2], ['february', 2], ['feb', 2],
    ['mart', 3], ['march', 3], ['mar', 3],
    ['april', 4], ['apr', 4],
    ['maij', 5], ['may', 5],
    ['junij', 6], ['june', 6], ['jun', 6],
    ['julij', 7], ['july', 7], ['jul', 7],
    ['august', 8], ['aug', 8],
    ['septembr', 9], ['september', 9], ['sep', 9],
    ['oktobr', 10], ['october', 10], ['oct', 10],
    ['novembr', 11], ['november', 11], ['nov', 11],
    ['decembr', 12], ['december', 12], ['dec', 12],
  ];
  for (const [prefix, number] of prefixes) {
    if (value.startsWith(prefix)) return number;
  }
  return 0;
}

function normalizeYear(year) {
  if (year >= 2000) return year;
  if (year >= 0 && year <= 99) return 2000 + year;
  return year;
}

function validUtcDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > CURRENT_YEAR + 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const timestamp = Date.UTC(year, month - 1, day, 12, 0, 0);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function buildDateResult(date, precision, source, uploadPosition) {
  const timestamp = date.getTime();
  return {
    iso: date.toISOString(),
    year: date.getUTCFullYear(),
    precision,
    source,
    sortTimestamp: timestamp - Math.min(Number(uploadPosition || 0), 999999),
  };
}

function buildYearResult(year, source, uploadPosition) {
  // Tikai gada precizitātes video liekam gada sākumā, tātad aiz visiem tā gada
  // video, kuriem atrasts precīzs datums. Pozīcija saglabā stabilu secību.
  const timestamp = Date.UTC(year, 0, 1, 0, 0, 0);
  return {
    iso: new Date(timestamp).toISOString(),
    year,
    precision: 'year',
    source,
    sortTimestamp: timestamp - Math.min(Number(uploadPosition || 0), 999999),
  };
}

function isShortsPlaylist(title) {
  const value = normalizeForDate(title);
  return /(^|\s)(shorts?|isie|isie klipi)(\s|$)/.test(value);
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

function json(body, status = 200, cacheControl = 'public, max-age=30, s-maxage=60, stale-while-revalidate=120') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
    },
  });
}
