const dev = {
  message: "Made with love\nby Kutomi for my lovely Vayree",
  version: "v3.8.55"
};

// =============================================================================
// SECTION 1: LIBRARY UI ENTRY POINTS
// =============================================================================

/**
 * Builds the top menu bar in Google Docs.
 */
function buildMenu() {
  DocumentApp.getUi()
    .createMenu('⭐ Tools:3')
    .addItem('📃 Citation Extractor', 'showSidebar')
    .addToUi();
}

/**
 * Evaluates Index.html and displays the sidebar.
 */
function showSidebar() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.dev = dev;
  const htmlOutput = template.evaluate()
    .setTitle('Citation Extractor')
    .setWidth(360);
  DocumentApp.getUi().showSidebar(htmlOutput);
}

// =============================================================================
// SECTION 2: BACKEND LOGIC (Occurrence Grouping, API Resolvers, Drive API)
// =============================================================================

/**
 * Escapes special Regex characters so DocumentApp.findText interprets strings literally.
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fetches all comments from the active document, groups identical anchor quotes,
 * maps occurrences sequentially to document positions, and sorts top-to-bottom.
 */
function getDocumentComments() {
  const doc = DocumentApp.getActiveDocument();
  const docId = doc.getId();
  const bodyText = doc.getBody().getText();
  
  let rawComments = [];
  let pageToken = null;

  do {
    const options = { 
      maxResults: 100,
      pageSize: 100,
      fields: '*'
    };
    if (pageToken) options.pageToken = pageToken;

    let response;
    try {
      response = Drive.Comments.list(docId, options);
    } catch (e) {
      throw new Error("Drive API Request Failed: " + e.message);
    }

    const items = response.items || response.comments || [];
    items.forEach((item, idx) => {
      const content = (item.content || item.htmlContent || '').trim();

      let quotedText = '';
      if (item.context && item.context.value) {
        quotedText = item.context.value;
      } else if (item.quotedFileContent && item.quotedFileContent.value) {
        quotedText = item.quotedFileContent.value;
      } else if (item.anchor) {
        try {
          const anchorObj = JSON.parse(item.anchor);
          quotedText = anchorObj.text || '';
        } catch (err) {
          quotedText = item.anchor;
        }
      }

      if (content) {
        rawComments.push({
          id: item.commentId || item.id || idx,
          content: content,
          quotedText: quotedText.trim(),
          createdTime: item.createdTime || item.createdDate || idx
        });
      }
    });

    pageToken = response.nextPageToken;
  } while (pageToken);

  // Preserve chronological creation order per anchor quote
  rawComments.sort((a, b) => (a.createdTime > b.createdTime ? 1 : -1));

  // Group comments by exact quoted text
  const groups = {};
  rawComments.forEach(c => {
    const key = c.quotedText || '__NO_QUOTE__';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  });

  const allComments = [];

  // Systematically map occurrence indices to physical document positions
  Object.keys(groups).forEach(quotedText => {
    const commentList = groups[quotedText];

    if (!quotedText || quotedText === '__NO_QUOTE__') {
      commentList.forEach((c, idx) => {
        allComments.push({
          id: c.id,
          content: c.content,
          quotedText: '',
          occurrenceIndex: 0,
          position: 999999 + idx
        });
      });
      return;
    }

    // Find all character positions of quotedText in document body
    const positions = [];
    let searchStart = 0;
    while (true) {
      const foundPos = bodyText.indexOf(quotedText, searchStart);
      if (foundPos === -1) break;
      positions.push(foundPos);
      searchStart = foundPos + 1;
    }

    // Assign sequential occurrence indices (0, 1, 2...)
    commentList.forEach((c, occIndex) => {
      const pos = (occIndex < positions.length) 
        ? positions[occIndex] 
        : (positions.length > 0 ? positions[positions.length - 1] : -1);

      allComments.push({
        id: c.id,
        content: c.content,
        quotedText: quotedText,
        occurrenceIndex: occIndex,
        position: pos !== -1 ? pos : 999999 + occIndex
      });
    });
  });

  // Sort all comments globally by physical document position
  allComments.sort((a, b) => a.position - b.position);

  return allComments;
}

/**
 * Processes a batch of up to 5 comments in a single server call.
 */
function processCommentBatch(batch) {
  if (!Array.isArray(batch)) return [];
  return batch.map(text => processSingleComment(text));
}

function processSingleComment(text) {
  // Captures DOIs including typos starting with '0.' instead of '10.'
  const doiRegex = /((?:10|0)\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/;
  const urlRegex = /(https?:\/\/[^\s]+)/;

  // Case 1: DOI Match (Auto-corrects "0." -> "10.")
  const doiMatch = text.match(doiRegex);
  if (doiMatch) {
    let cleanDoi = sanitizeExtractorTarget(doiMatch[0]);
    if (cleanDoi.startsWith('0.')) {
      cleanDoi = '10.' + cleanDoi.substring(2);
    }
    const apa = fetchAPAFromDOI(cleanDoi);
    if (apa) {
      return { text: apa, type: 'resolved' };
    }
    return { text: text, type: 'unresolved' };
  }

  // Case 2: URL Match
  const urlMatch = text.match(urlRegex);
  if (urlMatch) {
    const cleanUrl = sanitizeExtractorTarget(urlMatch[0]);
    const resolved = resolveUrlCitation(cleanUrl);
    if (resolved && !resolved.includes('Retrieved from')) {
      return { text: resolved, type: 'resolved' };
    }
    return { text: text, type: 'unresolved' };
  }

  // Case 3: Raw formatted comment (e.g., ISO standard)
  return { text: text, type: 'raw' };
}

function sanitizeExtractorTarget(rawStr) {
  return rawStr.replace(/[.,;)]+$/, '').trim();
}

function fetchAPAFromDOI(doi) {
  const cleanDoi = sanitizeExtractorTarget(doi);
  
  // Primary Attempt: DOI.org Content Negotiation
  const url = 'https://doi.org/' + encodeURIComponent(cleanDoi);
  try {
    const res = UrlFetchApp.fetch(url, {
      headers: { 
        "Accept": "text/x-bibliography; style=apa",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() === 200) {
      const text = res.getContentText().trim();
      if (text && !text.includes('HTML') && !text.includes('<!DOCTYPE')) {
        return text;
      }
    }
  } catch (e) {}

  // Fallback Attempt: Crossref REST API
  try {
    const crUrl = 'https://api.crossref.org/works/' + encodeURIComponent(cleanDoi);
    const crRes = UrlFetchApp.fetch(crUrl, { muteHttpExceptions: true });
    if (crRes.getResponseCode() === 200) {
      const crData = JSON.parse(crRes.getContentText());
      if (crData && crData.message) {
        const formattedApa = formatCrossrefAPA(crData.message, cleanDoi);
        if (formattedApa) return formattedApa;
      }
    }
  } catch (e) {}

  return null;
}

function formatCrossrefAPA(msg, doi) {
  try {
    let authors = '';
    if (msg.author && msg.author.length > 0) {
      const authorList = msg.author.map(a => {
        let name = a.family || '';
        if (a.given) {
          name += ', ' + a.given.split(' ').map(g => g[0] + '.').join(' ');
        }
        return name;
      });
      if (authorList.length === 1) authors = authorList[0];
      else if (authorList.length <= 7) authors = authorList.slice(0, -1).join(', ') + ', & ' + authorList[authorList.length - 1];
      else authors = authorList.slice(0, 6).join(', ') + ', ... ' + authorList[authorList.length - 1];
    }

    let year = '';
    if (msg.published && msg['published']['date-parts'] && msg['published']['date-parts'][0]) {
      year = msg['published']['date-parts'][0][0];
    } else if (msg.created && msg.created['date-parts'] && msg.created['date-parts'][0]) {
      year = msg.created['date-parts'][0][0];
    }

    let title = (msg.title && msg.title[0]) ? msg.title[0] : '';
    let container = (msg['container-title'] && msg['container-title'][0]) ? msg['container-title'][0] : '';
    let volume = msg.volume ? msg.volume : '';
    let issue = msg.issue ? '(' + msg.issue + ')' : '';
    let page = msg.page ? ', ' + msg.page : '';

    let result = '';
    if (authors) result += authors + ' ';
    if (year) result += '(' + year + '). ';
    if (title) result += title + '. ';
    if (container) result += container + ', ' + volume + issue + page + '. ';
    result += 'https://doi.org/' + doi;

    return result.trim();
  } catch(e) {
    return null;
  }
}

function resolveUrlCitation(url) {
  // Step 1: Query Semantic Scholar API
  try {
    const s2Url = 'https://api.semanticscholar.org/graph/v1/paper/URL:' + encodeURIComponent(url) + '?fields=externalIds';
    const s2Res = UrlFetchApp.fetch(s2Url, { muteHttpExceptions: true });
    if (s2Res.getResponseCode() === 200) {
      const s2Data = JSON.parse(s2Res.getContentText());
      if (s2Data && s2Data.externalIds && s2Data.externalIds.DOI) {
        const apa = fetchAPAFromDOI(sanitizeExtractorTarget(s2Data.externalIds.DOI));
        if (apa) return apa;
      }
    }
  } catch (e) {}

  // Step 2: Web scraping fallback
  try {
    const res = UrlFetchApp.fetch(url, { 
      muteHttpExceptions: true, 
      followRedirects: true,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      }
    });
    const html = res.getContentText();

    const metaDoi = html.match(/<meta[^>]+name=["'](?:citation_doi|DOI)["'][^>]+content=["']([^"']+)["']/i);
    if (metaDoi && metaDoi[1]) {
      const apa = fetchAPAFromDOI(sanitizeExtractorTarget(metaDoi[1]));
      if (apa) return apa;
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const domain = url.split('/')[2].replace('www.', '');

    return domain + '. ' + title + '. Retrieved from ' + url;
  } catch (e) {
    return null;
  }
}

/**
 * Focuses and highlights the exact occurrence of text in the document corresponding to the comment anchor.
 */
function jumpToCommentText(quotedText, occurrenceIndex) {
  if (!quotedText) return false;
  const doc = DocumentApp.getActiveDocument();
  const body = doc.getBody();
  
  const pattern = escapeRegex(quotedText);
  let match = body.findText(pattern);
  let count = 0;
  const targetOcc = occurrenceIndex || 0;

  while (match && count < targetOcc) {
    match = body.findText(pattern, match);
    count++;
  }

  if (match) {
    const element = match.getElement();
    const startOffset = match.getStartOffset();
    const endOffsetInclusive = match.getEndOffsetInclusive();

    const rangeBuilder = doc.newRange();
    rangeBuilder.addElementsBetween(element, startOffset, element, endOffsetInclusive);
    doc.setSelection(rangeBuilder.build());
    return true;
  }
  return false;
}