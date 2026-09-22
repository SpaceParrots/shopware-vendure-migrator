// Product media -> Vendure assets.
import { groupBy } from '../lib/util.mjs';

/**
 * Assets for every media file a family or offer uses (gallery or cover).
 * @param {object} raw Snapshot tables (media, media_translations).
 * @param {object[]} families Output of buildFamilies.
 * @param {string} mediaBaseUrl Public base URL the storefront serves media from.
 * @param {{ namesOf: Function }} ctx
 * @returns {Array<{ sourceId: string, url: string, fileName: string, mimeType: string, private: boolean, alt: Record<string, string> }>} Never throws.
 */
export function buildAssets(raw, families, mediaBaseUrl, { namesOf }) {
    const usedMedia = new Set(
        families.flatMap(f => [f, ...f.offers]).flatMap(x => [...x.mediaSourceIds, x.coverMediaSourceId]).filter(Boolean),
    );
    const mediaNames = groupBy(raw.media_translations, 'media_id');
    const base = mediaBaseUrl.replace(/\/$/, '');
    return raw.media
        .filter(m => usedMedia.has(m.id))
        .map(m => ({
            sourceId: m.id,
            url: `${base}/${m.path}`,
            fileName: `${m.file_name}.${m.file_extension}`,
            mimeType: m.mime_type,
            private: Boolean(m.private),
            alt: namesOf(mediaNames.get(m.id), 'alt'),
        }));
}
