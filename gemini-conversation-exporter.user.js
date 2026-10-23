// ==UserScript==
// @name         Gemini Conversation Exporter
// @namespace    local.gemini-web-exporter
// @version      0.7.0
// @description  Export Gemini conversations as validated Markdown, one at a time or in batches, using Gemini's own paginated history data.
// @author       dikelps, tribaud
// @license      MIT
// @homepageURL  https://github.com/tribaud/gemini-exporter
// @supportURL   https://github.com/tribaud/gemini-exporter/issues
// @updateURL    https://raw.githubusercontent.com/tribaud/gemini-exporter/master/gemini-conversation-exporter.user.js
// @downloadURL  https://raw.githubusercontent.com/tribaud/gemini-exporter/master/gemini-conversation-exporter.user.js
// @match        https://gemini.google.com/*
// @match        https://gemini.google.com/app
// @match        https://gemini.google.com/app/*
// @match        https://gemini.google.com/u/*/app
// @match        https://gemini.google.com/u/*/app/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @sandbox      JavaScript
// @noframes
// ==/UserScript==

(function initializeGeminiExporterCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.GeminiWebExporterCore = api;
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function createGeminiExporterCore() {
    "use strict";

    const HISTORY_RPC_ID = "hNvQHb";

    function invariant(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    function parseJsonLines(rawResponse) {
      invariant(
        typeof rawResponse === "string" && rawResponse.length > 0,
        "Gemini returned an empty history response.",
      );

      const withoutXssiPrefix = rawResponse.replace(/^\)\]\}'\r?\n?/, "");
      const parsedLines = [];

      for (const rawLine of withoutXssiPrefix.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || /^\d+$/.test(line)) {
          continue;
        }

        try {
          parsedLines.push(JSON.parse(line));
        } catch {
          // Batchexecute length markers and transport metadata are not payloads.
        }
      }

      invariant(
        parsedLines.length > 0,
        "Gemini's history response did not contain any JSON payloads.",
      );

      return parsedLines;
    }

    function findRpcPayload(value, rpcId) {
      if (!Array.isArray(value)) {
        return null;
      }

      if (
        value[0] === "wrb.fr" &&
        value[1] === rpcId &&
        typeof value[2] === "string"
      ) {
        return value[2];
      }

      for (const child of value) {
        const match = findRpcPayload(child, rpcId);
        if (match !== null) {
          return match;
        }
      }

      return null;
    }

    function parseBatchexecuteResponse(rawResponse, rpcId = HISTORY_RPC_ID) {
      const chunks = parseJsonLines(rawResponse);

      for (const chunk of chunks) {
        const encodedPayload = findRpcPayload(chunk, rpcId);
        if (encodedPayload === null) {
          continue;
        }

        try {
          return JSON.parse(encodedPayload);
        } catch (error) {
          throw new Error(
            `Gemini returned malformed JSON for history RPC ${rpcId}: ${error.message}`,
          );
        }
      }

      throw new Error(
        `Gemini's response did not contain history RPC ${rpcId}. The private API may have changed.`,
      );
    }

    function parseHistoryPage(rawResponse) {
      const payload = parseBatchexecuteResponse(rawResponse, HISTORY_RPC_ID);

      invariant(
        Array.isArray(payload) && Array.isArray(payload[0]),
        "Gemini returned an unrecognized history payload.",
      );

      const cursor =
        typeof payload[1] === "string" && payload[1].length > 0
          ? payload[1]
          : null;

      return {
        rawTurns: payload[0],
        cursor,
      };
    }

    async function collectHistoryPages(
      fetchPage,
      { maxPages = 200 } = {},
    ) {
      invariant(typeof fetchPage === "function", "fetchPage must be a function.");

      const pages = [];
      const seenCursors = new Set();
      let cursor = null;

      for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
        const rawResponse = await fetchPage(cursor, pageNumber);
        const page =
          typeof rawResponse === "string"
            ? parseHistoryPage(rawResponse)
            : rawResponse;

        invariant(
          page && Array.isArray(page.rawTurns),
          `Gemini history page ${pageNumber + 1} was invalid.`,
        );

        pages.push(page);

        if (!page.cursor) {
          return {
            pages,
            rawTurnsNewestFirst: pages.flatMap(
              (historyPage) => historyPage.rawTurns,
            ),
          };
        }

        invariant(
          page.rawTurns.length > 0,
          "Gemini returned a continuation cursor with no turns.",
        );
        invariant(
          !seenCursors.has(page.cursor),
          "Gemini repeated a history cursor; export stopped to avoid duplicate turns.",
        );

        seenCursors.add(page.cursor);
        cursor = page.cursor;
      }

      throw new Error(
        `Export exceeded ${maxPages} history pages. Stopped instead of producing a potentially incomplete file.`,
      );
    }

    function timestampToIso(timestampTuple) {
      if (
        !Array.isArray(timestampTuple) ||
        !Number.isFinite(Number(timestampTuple[0]))
      ) {
        return null;
      }

      const seconds = Number(timestampTuple[0]);
      const nanoseconds = Number(timestampTuple[1] || 0);
      const milliseconds = seconds * 1000 + nanoseconds / 1_000_000;
      const date = new Date(milliseconds);

      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function extractSelectedCandidate(rawTurn) {
      const candidates = rawTurn?.[3]?.[0];
      if (!Array.isArray(candidates)) {
        return null;
      }

      return (
        candidates.find(
          (candidate) =>
            Array.isArray(candidate) &&
            typeof candidate?.[1]?.[0] === "string" &&
            candidate[1][0].length > 0,
        ) || null
      );
    }

    function extractTurn(rawTurn, sourceIndex) {
      invariant(
        Array.isArray(rawTurn),
        `Gemini turn ${sourceIndex + 1} was not an array.`,
      );

      const userMarkdown = rawTurn?.[2]?.[0]?.[0];
      const candidate = extractSelectedCandidate(rawTurn);
      const assistantMarkdown = candidate?.[1]?.[0];

      return {
        conversationId:
          typeof rawTurn?.[0]?.[0] === "string"
            ? rawTurn[0][0]
            : rawTurn?.[1]?.[0] || null,
        responseId:
          typeof rawTurn?.[0]?.[1] === "string" ? rawTurn[0][1] : null,
        parentResponseId:
          typeof rawTurn?.[1]?.[1] === "string" ? rawTurn[1][1] : null,
        candidateId:
          typeof candidate?.[0] === "string"
            ? candidate[0]
            : rawTurn?.[3]?.[3] || null,
        parentCandidateId:
          typeof rawTurn?.[1]?.[2] === "string" ? rawTurn[1][2] : null,
        userMarkdown:
          typeof userMarkdown === "string" ? userMarkdown : "",
        assistantMarkdown:
          typeof assistantMarkdown === "string" ? assistantMarkdown : "",
        timestamp: timestampToIso(rawTurn?.[4]),
        // Sans texte, aucune réponse n'est retenue : on fouille alors la
        // première, celle qu'affiche Gemini.
        extras: harvestExtras(
          rawTurn,
          candidate || rawTurn?.[3]?.[0]?.[0],
          typeof userMarkdown === "string" ? userMarkdown : "",
          typeof assistantMarkdown === "string" ? assistantMarkdown : "",
        ),
        sourceIndex,
      };
    }

    const URL_PATTERN = /^https?:\/\/\S+$/;
    // Icônes de sites et miniatures servies par Google : du décor, pas une
    // source.
    const DECORATIVE_HOST_PATTERN = /(^|\.)(gstatic\.com|ytimg\.com|ggpht\.com)$/i;

    function isDecorativeUrl(url) {
      try {
        const parsed = new URL(url);
        return (
          DECORATIVE_HOST_PATTERN.test(parsed.hostname) ||
          /favicon/i.test(parsed.pathname)
        );
      } catch {
        return true;
      }
    }

    // Une même page citée avec plusieurs ancres (#:~:text=…) ne compte qu'une
    // fois.
    function urlWithoutFragment(url) {
      return url.replace(/#.*$/, "");
    }
    const EXTRA_TEXT_MIN_LENGTH = 200;

    function collectStrings(value, path, output) {
      if (typeof value === "string") {
        output.push({ path, value });
      } else if (Array.isArray(value)) {
        value.forEach((child, index) =>
          collectStrings(child, `${path}.${index}`, output),
        );
      }
    }

    // Contenu hors du texte principal : images générées, fichiers joints,
    // Canvas, sources… On ne connaît pas leur emplacement exact dans les
    // données de Gemini, donc on ramasse dans le prompt et dans la réponse
    // retenue toute URL et tout texte long qui ne figure pas déjà dans le
    // texte principal. Le chemin est conservé pour affiner plus tard.
    function harvestExtras(rawTurn, candidate, userMarkdown, assistantMarkdown) {
      const strings = [];
      collectStrings(rawTurn?.[2], "turn.2", strings);
      collectStrings(candidate, "candidate", strings);

      const mainTexts = [userMarkdown, assistantMarkdown];
      const isAlreadyShown = (text) =>
        mainTexts.some((main) => main.includes(text));
      const seen = new Set();
      const seenPages = new Set();
      const urls = [];
      const texts = [];

      for (const { path, value } of strings) {
        const text = value.trim();
        if (!text || seen.has(text)) {
          continue;
        }
        seen.add(text);

        if (path === "turn.2.0.0" || path === "candidate.1.0") {
          continue;
        }
        if (URL_PATTERN.test(text)) {
          const page = urlWithoutFragment(text);
          if (
            !isDecorativeUrl(text) &&
            !seenPages.has(page) &&
            !isAlreadyShown(page)
          ) {
            seenPages.add(page);
            urls.push({ path, url: text });
          }
          continue;
        }
        // Un texte sans espace est un identifiant ou un jeton, pas du contenu.
        if (
          text.length >= EXTRA_TEXT_MIN_LENGTH &&
          /\s/.test(text) &&
          !isAlreadyShown(text)
        ) {
          texts.push({ path, text });
        }
      }

      return { urls, texts };
    }

    function historyToChronologicalTurns(rawTurnsNewestFirst) {
      invariant(
        Array.isArray(rawTurnsNewestFirst),
        "Gemini history turns were missing.",
      );

      const seenResponseIds = new Set();
      const uniqueNewestFirst = [];

      rawTurnsNewestFirst.forEach((rawTurn, sourceIndex) => {
        const turn = extractTurn(rawTurn, sourceIndex);
        const dedupeKey =
          turn.responseId ||
          `${turn.timestamp || "unknown"}\u0000${turn.userMarkdown}\u0000${turn.assistantMarkdown}`;

        if (seenResponseIds.has(dedupeKey)) {
          return;
        }

        seenResponseIds.add(dedupeKey);
        uniqueNewestFirst.push(turn);
      });

      return uniqueNewestFirst.reverse();
    }

    function countOccurrences(text, expression) {
      return (text.match(expression) || []).length;
    }

    function fnv1a(text) {
      let hash = 0x811c9dc5;

      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
      }

      return (hash >>> 0).toString(16).padStart(8, "0");
    }

    // Délai maximal entre une réponse vide et l'échange suivant pour y voir
    // une interruption (l'utilisateur a repris la parole).
    const INTERRUPTION_MAX_GAP_MS = 30_000;

    // Reconnaît les vides propres aux sessions vocales :
    // - au premier échange, Gemini parle sans question (« Bonjour ! »), ou un
    //   échange entièrement vide ouvre la session ;
    // - en cours de route, une réponse vide suivie de près par l'échange
    //   suivant : l'utilisateur a coupé la parole à Gemini ;
    // - dans une session repérée comme vocale (premier échange sans question),
    //   une réponse sans question : Gemini a repris la parole après une pause.
    function voiceSessionNote(turns, index) {
      const turn = turns[index];
      const hasUser = turn.userMarkdown.trim().length > 0;
      const hasAnswer = turn.assistantMarkdown.trim().length > 0;

      if (index === 0 && !hasUser) {
        return hasAnswer ? "gemini-spoke-first" : "voice-session-start";
      }

      const isVoiceSession = !turns[0].userMarkdown.trim();
      if (index > 0 && !hasUser && hasAnswer && isVoiceSession) {
        return "gemini-continued";
      }

      const next = turns[index + 1];
      if (hasUser && !hasAnswer && next && turn.timestamp && next.timestamp) {
        const gap = Date.parse(next.timestamp) - Date.parse(turn.timestamp);
        if (gap >= 0 && gap <= INTERRUPTION_MAX_GAP_MS) {
          return "interrupted-answer";
        }
      }

      return null;
    }

    // En mode tolérant, les anomalies sont rendues dans diagnostics.problems
    // au lieu d'arrêter l'export.
    function validateConversation(turns, { lenient = false } = {}) {
      invariant(Array.isArray(turns), "Exported turns were missing.");
      invariant(turns.length > 0, "Gemini returned no conversation turns.");

      const missing = [];
      const responseIds = new Set();
      const duplicateResponseIds = [];
      const bodyFingerprints = new Set();
      const duplicateBodies = [];
      const chainBreaks = [];
      const timestampRegressions = [];
      const markdownWarnings = [];
      // Détail structuré de chaque anomalie bloquante, pour le diagnostic.
      const problems = [];
      // Vides normaux d'une session vocale (Gemini Live) : signalés dans le
      // fichier, mais ni bloquants ni comptés comme avertissements.
      const notes = [];

      turns.forEach((turn, index) => {
        const voiceNote = voiceSessionNote(turns, index);
        if (voiceNote) {
          notes.push({ kind: voiceNote, turn: index + 1 });
        }
        const userIsExplained =
          voiceNote === "gemini-spoke-first" ||
          voiceNote === "voice-session-start" ||
          voiceNote === "gemini-continued";
        const answerIsExplained =
          voiceNote === "interrupted-answer" || voiceNote === "voice-session-start";

        if (!turn.userMarkdown.trim() && !userIsExplained) {
          missing.push(`turn ${index + 1} user message`);
          problems.push({
            kind: "missing-user-message",
            turn: index + 1,
            responseId: turn.responseId,
            sourceIndex: turn.sourceIndex,
          });
        }
        if (!turn.assistantMarkdown.trim() && !answerIsExplained) {
          missing.push(`turn ${index + 1} Gemini response`);
          problems.push({
            kind: "missing-gemini-response",
            turn: index + 1,
            responseId: turn.responseId,
            sourceIndex: turn.sourceIndex,
          });
        }

        if (turn.responseId) {
          if (responseIds.has(turn.responseId)) {
            duplicateResponseIds.push(turn.responseId);
            problems.push({
              kind: "duplicate-response-id",
              turn: index + 1,
              responseId: turn.responseId,
              sourceIndex: turn.sourceIndex,
            });
          }
          responseIds.add(turn.responseId);
        }

        const bodyFingerprint = fnv1a(
          `${turn.userMarkdown}\u0000${turn.assistantMarkdown}`,
        );
        if (bodyFingerprints.has(bodyFingerprint)) {
          duplicateBodies.push(index + 1);
        }
        bodyFingerprints.add(bodyFingerprint);

        if (index > 0) {
          const previous = turns[index - 1];
          if (
            turn.parentResponseId &&
            previous.responseId &&
            turn.parentResponseId !== previous.responseId
          ) {
            chainBreaks.push({
              turn: index + 1,
              expectedParent: previous.responseId,
              actualParent: turn.parentResponseId,
            });
            problems.push({
              kind: "branch-discontinuity",
              turn: index + 1,
              responseId: turn.responseId,
              sourceIndex: turn.sourceIndex,
              expectedParent: previous.responseId,
              actualParent: turn.parentResponseId,
            });
          }

          if (
            turn.timestamp &&
            previous.timestamp &&
            Date.parse(turn.timestamp) < Date.parse(previous.timestamp)
          ) {
            timestampRegressions.push(index + 1);
          }
        }

        for (const [role, markdown] of [
          ["user", turn.userMarkdown],
          ["Gemini", turn.assistantMarkdown],
        ]) {
          if (countOccurrences(markdown, /```/g) % 2 !== 0) {
            markdownWarnings.push(
              `turn ${index + 1} ${role} text has an unbalanced code fence`,
            );
          }

          if (countOccurrences(markdown, /\$\$/g) % 2 !== 0) {
            markdownWarnings.push(
              `turn ${index + 1} ${role} text has an unbalanced display-math delimiter`,
            );
          }
        }
      });

      function validationError(message) {
        const error = new Error(message);
        error.problems = problems;
        return error;
      }

      if (!lenient && missing.length > 0) {
        throw validationError(
          `Export stopped because content was missing: ${missing.join(", ")}.`,
        );
      }
      if (!lenient && duplicateResponseIds.length > 0) {
        throw validationError(
          "Export stopped because Gemini returned duplicate response IDs.",
        );
      }
      if (!lenient && chainBreaks.length > 0) {
        throw validationError(
          `Export stopped because the active conversation branch was discontinuous at turn ${chainBreaks[0].turn}.`,
        );
      }

      const fingerprint = fnv1a(
        turns
          .map(
            (turn) =>
              `${turn.responseId || ""}\u0000${turn.userMarkdown}\u0000${turn.assistantMarkdown}`,
          )
          .join("\u0001"),
      );

      return {
        turnCount: turns.length,
        duplicateBodies,
        timestampRegressions,
        markdownWarnings,
        problems,
        notes,
        fingerprint,
      };
    }

    function normalizeBlock(markdown) {
      return String(markdown)
        .replace(/\r\n?/g, "\n")
        .replace(/^\n+|\n+$/g, "");
    }

    function escapeMarkdownLinkDestination(url) {
      return String(url).replace(/[()\\]/g, "\\$&");
    }

    function turnPreview(markdown, maxLength = 72) {
      const plainText = normalizeBlock(markdown)
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/```[^\n]*\n?/g, " ")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/[`*_~#$>|]/g, " ")
        .replace(/^\s*(?:[-+*]|\d+[.)])\s+/gm, "")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .trim();

      if (plainText.length <= maxLength) {
        return plainText;
      }

      const candidate = plainText.slice(0, maxLength + 1);
      const lastSpace = candidate.lastIndexOf(" ");
      const clipped =
        lastSpace >= Math.floor(maxLength * 0.6)
          ? candidate.slice(0, lastSpace)
          : plainText.slice(0, maxLength);

      return `${clipped.trimEnd()}…`;
    }

    function escapeMarkdownLinkText(text) {
      return String(text).replace(/([\\[\]])/g, "\\$1");
    }

    const VOICE_PLACEHOLDERS = Object.freeze({
      "gemini-spoke-first": { user: "Gemini spoke first (voice session)" },
      "voice-session-start": {
        user: "voice session start",
        answer: "voice session start",
      },
      "interrupted-answer": {
        answer: "interrupted before Gemini replied (voice session)",
      },
      "gemini-continued": {
        user: "Gemini continued speaking after a pause (voice session)",
      },
    });

    // Bloc de code dont la clôture ne peut pas apparaître dans le contenu.
    function fenceFor(text) {
      const longestRun = Math.max(
        0,
        ...(String(text).match(/~+/g) || []).map((run) => run.length),
      );
      return "~".repeat(Math.max(4, longestRun + 1));
    }

    // Libellé court d'un lien : domaine et début du chemin, sans le bruit des
    // paramètres de requête.
    function linkLabel(url) {
      try {
        const parsed = new URL(url);
        const label = `${parsed.hostname.replace(/^www\./, "")}${
          parsed.pathname === "/" ? "" : decodeURIComponent(parsed.pathname)
        }`;
        return label.length > 80 ? `${label.slice(0, 80)}…` : label;
      } catch {
        return url.length > 80 ? `${url.slice(0, 80)}…` : url;
      }
    }

    function renderExtras(extras, { includeMetadata, includeOutline }) {
      if (!extras || (extras.urls.length === 0 && extras.texts.length === 0)) {
        return [];
      }

      const heading = includeOutline ? "####" : "###";
      const lines = [];

      if (extras.urls.length > 0) {
        lines.push(`${heading} Sources`, "");
        for (const { path, url } of extras.urls) {
          lines.push(
            `- [${escapeMarkdownLinkText(linkLabel(url))}](${escapeMarkdownLinkDestination(url)})${
              includeMetadata ? ` <!-- ${path} -->` : ""
            }`,
          );
        }
        lines.push("");
      }

      if (extras.texts.length > 0) {
        lines.push(`${heading} Additional content`, "");
        for (const { path, text } of extras.texts) {
          const fence = fenceFor(text);
          if (includeMetadata) {
            lines.push(`<!-- gemini-export-extra: ${path} -->`);
          }
          lines.push(`${fence}text`, normalizeBlock(text), fence, "");
        }
      }

      return lines;
    }

    function renderMarkdown({
      title,
      sourceUrl,
      conversationId,
      exportedAt,
      turns,
      diagnostics,
      includeMetadata = true,
      includeOutline = true,
    }) {
      invariant(Array.isArray(turns) && turns.length > 0, "No turns to render.");

      const safeTitle = normalizeBlock(title || "Gemini conversation").replace(
        /\n+/g,
        " ",
      );
      const lines = [`# ${safeTitle}`, ""];
      const notesByTurn = new Map(
        (diagnostics.notes || []).map((note) => [note.turn, note.kind]),
      );

      if (includeMetadata) {
        lines.push(
          `> Source: [Google Gemini](${escapeMarkdownLinkDestination(sourceUrl)})`,
          `> Exported: ${exportedAt}`,
          `> Conversation: ${conversationId}`,
          `> Turns: ${turns.length}`,
          `> Validation fingerprint: \`${diagnostics.fingerprint}\``,
        );
        for (const problem of diagnostics.problems || []) {
          lines.push(`> Warning: turn ${problem.turn}, ${problem.kind}`);
        }
        for (const note of diagnostics.notes || []) {
          lines.push(`> Note: turn ${note.turn}, ${note.kind}`);
        }
        lines.push("");
      }

      if (includeOutline) {
        lines.push("## Conversation outline", "");
        turns.forEach((turn, index) => {
          const number = index + 1;
          const preview = turnPreview(turn.userMarkdown);
          const label = preview
            ? `Turn ${number} — ${preview}`
            : `Turn ${number}`;

          lines.push(
            `${number}. [${escapeMarkdownLinkText(label)}](#turn-${number})`,
          );
        });
        lines.push("");
      }

      turns.forEach((turn, index) => {
        if (index > 0) {
          lines.push("---", "");
        }

        if (includeMetadata) {
          const commentParts = [
            `turn=${index + 1}`,
            turn.responseId ? `response=${turn.responseId}` : null,
            turn.candidateId ? `candidate=${turn.candidateId}` : null,
            turn.timestamp ? `timestamp=${turn.timestamp}` : null,
          ].filter(Boolean);

          lines.push(
            `<!-- gemini-export: ${commentParts.join(" ")} -->`,
            "",
          );
        }

        if (includeOutline) {
          lines.push(`## turn-${index + 1}`, "", "### User", "");
        } else {
          lines.push("## User", "");
        }

        const hasExtras =
          turn.extras?.urls.length > 0 || turn.extras?.texts.length > 0;
        const missingText = `non-text content${
          hasExtras ? ", see below" : " that could not be exported"
        }`;
        const voiceNote = notesByTurn.get(index + 1);
        lines.push(
          turn.userMarkdown.trim()
            ? normalizeBlock(turn.userMarkdown)
            : `_[No prompt: ${VOICE_PLACEHOLDERS[voiceNote]?.user || missingText}]_`,
          "",
        );

        if (includeOutline) {
          lines.push("### Gemini", "");
        } else {
          lines.push("## Gemini", "");
        }

        lines.push(
          turn.assistantMarkdown.trim()
            ? normalizeBlock(turn.assistantMarkdown)
            : `_[No answer: ${VOICE_PLACEHOLDERS[voiceNote]?.answer || missingText}]_`,
          "",
        );

        lines.push(...renderExtras(turn.extras, { includeMetadata, includeOutline }));
      });

      return `${lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim()}\n`;
    }

    function conversationIdFromPath(pathname) {
      const parts = String(pathname).split("/").filter(Boolean);
      const appIndex =
        parts[0] === "u" && /^\d+$/.test(parts[1] || "") ? 2 : 0;

      if (parts[appIndex] !== "app" || !parts[appIndex + 1]) {
        return null;
      }

      const conversationId = parts[appIndex + 1];
      return conversationId.startsWith("c_")
        ? conversationId
        : `c_${conversationId}`;
    }

    function accountScopedPath(pathname, targetPath) {
      const accountMatch = String(pathname).match(/^\/u\/(\d+)(?:\/|$)/);
      const normalizedTarget = `/${String(targetPath).replace(/^\/+/, "")}`;

      return accountMatch
        ? `/u/${accountMatch[1]}${normalizedTarget}`
        : normalizedTarget;
    }

    function cleanDocumentTitle(documentTitle) {
      const withoutProduct = String(documentTitle || "")
        .replace(/\s*[-–—]\s*Google Gemini\s*$/i, "")
        .trim();

      return withoutProduct || "Gemini conversation";
    }

    function safeFilename(title) {
      const cleaned = String(title || "Gemini conversation")
        .normalize("NFKC")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/\s+/g, " ")
        .replace(/[.\s-]+$/g, "")
        .trim()
        .slice(0, 120);

      return `${cleaned || "Gemini conversation"}.md`;
    }

    // Nom de fichier pour l'export par lot : date du premier tour en préfixe
    // pour un tri chronologique, identifiant court en suffixe pour éviter les
    // collisions entre conversations de même titre.
    function batchFilename(title, conversationId, firstTimestamp) {
      const base = safeFilename(title).replace(/\.md$/, "");
      const datePrefix =
        typeof firstTimestamp === "string" && firstTimestamp.length >= 10
          ? `${firstTimestamp.slice(0, 10)} `
          : "";
      const shortId = String(conversationId || "")
        .replace(/^c_/, "")
        .slice(0, 8);

      return `${datePrefix}${base}${shortId ? ` [${shortId}]` : ""}.md`;
    }

    // Extrait les identifiants de conversation d'un attribut href ou jslog.
    function conversationIdFromReference(reference) {
      const text = String(reference || "");
      const fromPath = text.match(/\/app\/([0-9a-f]{8,})(?:[/?#"]|$)/i);
      if (fromPath) {
        return `c_${fromPath[1]}`;
      }

      const fromJslog = text.match(/\bc_([0-9a-f]{8,})\b/i);
      return fromJslog ? `c_${fromJslog[1]}` : null;
    }

    const CRC32_TABLE = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
          c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
      }
      return table;
    })();

    function crc32(bytes) {
      let crc = 0xffffffff;
      for (let index = 0; index < bytes.length; index += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    // Archive ZIP sans compression (méthode « store ») : suffisant pour du
    // Markdown et évite toute dépendance externe. Renvoie les morceaux à
    // passer au constructeur Blob.
    function buildZipParts(files, date = new Date()) {
      invariant(Array.isArray(files) && files.length > 0, "No files to zip.");
      invariant(files.length < 0xffff, "Too many files for a single ZIP.");

      const encoder = new TextEncoder();
      const dosTime =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        (date.getSeconds() >> 1);
      const dosDate =
        ((date.getFullYear() - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();
      const localParts = [];
      const centralParts = [];
      let offset = 0;

      for (const file of files) {
        const nameBytes = encoder.encode(file.name);
        const data =
          typeof file.content === "string"
            ? encoder.encode(file.content)
            : file.content;
        const checksum = crc32(data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // noms en UTF-8
        local.setUint16(8, 0, true);
        local.setUint16(10, dosTime, true);
        local.setUint16(12, dosDate, true);
        local.setUint32(14, checksum, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        localParts.push(new Uint8Array(local.buffer), nameBytes, data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        central.setUint16(8, 0x0800, true);
        central.setUint16(10, 0, true);
        central.setUint16(12, dosTime, true);
        central.setUint16(14, dosDate, true);
        central.setUint32(16, checksum, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, nameBytes.length, true);
        central.setUint16(30, 0, true);
        central.setUint16(32, 0, true);
        central.setUint16(34, 0, true);
        central.setUint16(36, 0, true);
        central.setUint32(38, 0, true);
        central.setUint32(42, offset, true);
        centralParts.push(new Uint8Array(central.buffer), nameBytes);

        offset += 30 + nameBytes.length + data.length;
      }

      const centralSize = centralParts.reduce(
        (total, part) => total + part.length,
        0,
      );
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(4, 0, true);
      end.setUint16(6, 0, true);
      end.setUint16(8, files.length, true);
      end.setUint16(10, files.length, true);
      end.setUint32(12, centralSize, true);
      end.setUint32(16, offset, true);
      end.setUint16(20, 0, true);

      return [...localParts, ...centralParts, new Uint8Array(end.buffer)];
    }

    // Explication probable de chaque type d'anomalie, reprise dans les logs.
    const PROBLEM_HINTS = Object.freeze({
      "missing-user-message":
        "The prompt has no text: probably an image, file or audio sent alone, or a prompt from a Gem/extension.",
      "missing-gemini-response":
        "The answer has no text at the usual place: probably a generated image, Canvas, Deep Research report, video, blocked or interrupted answer.",
      "duplicate-response-id":
        "Gemini returned the same turn twice across history pages.",
      "branch-discontinuity":
        "The turn does not follow the previous one: probably an edited prompt or a regenerated answer creating another branch.",
    });

    // Résumé lisible de la structure brute d'un tour : les chaînes sont
    // tronquées, les tableaux longs coupés, pour voir où se trouve (ou non)
    // le contenu sans recopier toute la conversation dans les logs.
    function describeValue(
      value,
      { maxDepth = 12, maxItems = 40, maxString = 120 } = {},
      depth = 0,
    ) {
      if (typeof value === "string") {
        return value.length <= maxString
          ? value
          : `${value.slice(0, maxString)}… (${value.length} chars)`;
      }
      if (!value || typeof value !== "object") {
        return value;
      }
      if (depth >= maxDepth) {
        return Array.isArray(value) ? `[array(${value.length})]` : "[object]";
      }
      if (Array.isArray(value)) {
        const items = value
          .slice(0, maxItems)
          .map((item) =>
            describeValue(item, { maxDepth, maxItems, maxString }, depth + 1),
          );
        if (value.length > maxItems) {
          items.push(`… ${value.length - maxItems} more items`);
        }
        return items;
      }
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, maxItems)
          .map(([key, item]) => [
            key,
            describeValue(item, { maxDepth, maxItems, maxString }, depth + 1),
          ]),
      );
    }

    return Object.freeze({
      HISTORY_RPC_ID,
      PROBLEM_HINTS,
      describeValue,
      accountScopedPath,
      batchFilename,
      buildZipParts,
      cleanDocumentTitle,
      collectHistoryPages,
      conversationIdFromPath,
      conversationIdFromReference,
      crc32,
      extractTurn,
      fnv1a,
      historyToChronologicalTurns,
      parseBatchexecuteResponse,
      parseHistoryPage,
      renderMarkdown,
      safeFilename,
      turnPreview,
      validateConversation,
    });
  },
);

(function runGeminiExporterUserscript() {
  "use strict";

  if (typeof document === "undefined") {
    return;
  }

  const Core = globalThis.GeminiWebExporterCore;
  if (!Core) {
    throw new Error("Gemini exporter core failed to initialize.");
  }

  const ROOT_ID = "gemini-web-exporter-root";
  // Version lue dans l'en-tête par Tampermonkey : une seule source de vérité.
  const SCRIPT_VERSION =
    typeof GM_info !== "undefined" && GM_info?.script?.version
      ? GM_info.script.version
      : null;
  const HISTORY_PAGE_SIZE = 50;
  // Nombre de conversations ajoutées à la liste à chaque « Load more ».
  const LIST_PAGE_SIZE = 50;
  const PREFERENCE_KEYS = Object.freeze({
    collapsed: "ui.collapsed",
    includeMetadata: "export.includeMetadata",
    includeOutline: "export.includeOutline",
    lenient: "export.lenient",
    batchAsZip: "batch.asZip",
    batchCatalog: "batch.catalog",
    batchExported: "batch.exported",
    batchFailed: "batch.failed",
  });
  // Pause entre deux conversations pour ne pas marteler l'API privée.
  const BATCH_DELAY_MS = 1_500;
  const BATCH_DELAY_JITTER_MS = 1_000;
  // La vérification des nouveaux messages ne lit qu'un échange : pause courte.
  const CHECK_DELAY_MS = 400;
  const CHECK_DELAY_JITTER_MS = 300;
  const SIDEBAR_SCROLL_WAIT_MS = 1_200;
  const SIDEBAR_STABLE_ROUNDS = 3;
  const SIDEBAR_MAX_ROUNDS = 300;
  const pageWindow =
    typeof unsafeWindow !== "undefined" ? unsafeWindow : globalThis;

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function getGeminiConfig() {
    const config = pageWindow.WIZ_global_data;
    const required = ["cfb2h", "FdrFJe", "SNlM0e"];

    if (
      !config ||
      required.some(
        (key) => typeof config[key] !== "string" || config[key].length === 0,
      )
    ) {
      throw new Error(
        "Gemini's page configuration is not ready. Reload the conversation and try again.",
      );
    }

    return config;
  }

  function makeRequestId() {
    return String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  }

  function cloneForPageRealm(value) {
    return typeof cloneInto === "function"
      ? cloneInto(value, pageWindow)
      : value;
  }

  function readPreference(key, fallback, isValid) {
    if (typeof GM_getValue !== "function") {
      return fallback;
    }

    try {
      const value = GM_getValue(key, fallback);
      return isValid(value) ? value : fallback;
    } catch (error) {
      console.warn("[Gemini Exporter] Could not read preference", key, error);
      return fallback;
    }
  }

  function writePreference(key, value) {
    if (typeof GM_setValue !== "function") {
      return;
    }

    try {
      GM_setValue(key, value);
    } catch (error) {
      console.warn("[Gemini Exporter] Could not save preference", key, error);
    }
  }

  function readBooleanPreference(key, fallback) {
    return readPreference(key, fallback, (value) => typeof value === "boolean");
  }

  function writeBooleanPreference(key, value) {
    writePreference(key, Boolean(value));
  }

  function readObjectPreference(key) {
    return readPreference(
      key,
      {},
      (value) =>
        value !== null && typeof value === "object" && !Array.isArray(value),
    );
  }

  function conversationPath(conversationId) {
    return Core.accountScopedPath(
      location.pathname,
      `/app/${conversationId.replace(/^c_/, "")}`,
    );
  }

  async function fetchHistoryPage(
    conversationId,
    cursor,
    pageSize = HISTORY_PAGE_SIZE,
  ) {
    const config = getGeminiConfig();
    const query = new URLSearchParams({
      rpcids: Core.HISTORY_RPC_ID,
      "source-path": conversationPath(conversationId),
      bl: config.cfb2h,
      "f.sid": config.FdrFJe,
      hl: (document.documentElement.lang || "en").split("-")[0],
      _reqid: makeRequestId(),
      rt: "c",
    });
    const pageId = new URLSearchParams(location.search).get("pageId");
    if (pageId) {
      query.set("pageId", pageId);
    }
    const rpcArguments = [
      conversationId,
      pageSize,
      cursor,
      1,
      [0],
      [4],
      null,
      1,
    ];
    const rpcCall = [
      Core.HISTORY_RPC_ID,
      JSON.stringify(rpcArguments),
      null,
      "generic",
    ];
    const body = new URLSearchParams({
      "f.req": JSON.stringify([[rpcCall]]),
      at: config.SNlM0e,
    });
    const endpointPath = Core.accountScopedPath(
      location.pathname,
      "/_/BardChatUi/data/batchexecute",
    );
    const endpoint = new URL(endpointPath, location.origin);
    endpoint.search = query.toString();

    const requestOptions = cloneForPageRealm({
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: body.toString(),
    });
    const response = await pageWindow.fetch(
      endpoint.toString(),
      requestOptions,
    );
    const text = await response.text();

    if (!response.ok) {
      const error = new Error(
        `Gemini history request failed with HTTP ${response.status}.`,
      );
      error.httpStatus = response.status;
      error.responsePreview = text.slice(0, 500);
      throw error;
    }

    return text;
  }

  // Dernier échange d'une conversation, en une requête d'une seule page d'un
  // seul échange : l'historique est renvoyé du plus récent au plus ancien.
  async function fetchLatestTurn(conversationId) {
    const page = Core.parseHistoryPage(
      await fetchHistoryPage(conversationId, null, 1),
    );
    if (page.rawTurns.length === 0) {
      throw new Error("Gemini returned no turn for this conversation.");
    }
    const turn = Core.extractTurn(page.rawTurns[0], 0);
    return { responseId: turn.responseId, timestamp: turn.timestamp };
  }

  // Une conversation exportée a-t-elle reçu des messages depuis ? On compare
  // l'identifiant du dernier échange quand on l'a, sinon la date d'export
  // (exports faits avant que cet identifiant soit mémorisé).
  function hasNewMessages(record, latest) {
    if (record.lastResponseId && latest.responseId) {
      return latest.responseId !== record.lastResponseId;
    }
    if (!latest.timestamp) {
      return false;
    }
    return Date.parse(latest.timestamp) > Date.parse(record.lastTurnAt || record.at);
  }

  // Récupère, valide et rend une conversation, sans rien télécharger.
  // En cas d'échec, l'erreur porte un rapport (error.report) qui dit à quelle
  // étape on s'est arrêté et, pour les tours fautifs, ce que Gemini a renvoyé.
  async function buildConversationExport({
    conversationId,
    title,
    preferences,
  }) {
    const report = {
      conversationId,
      title,
      url: new URL(conversationPath(conversationId), location.origin).toString(),
      stage: "fetch",
      pagesFetched: 0,
    };
    let lastRawResponse = "";
    let history = null;
    let turns = null;

    try {
      history = await Core.collectHistoryPages(async (cursor, pageNumber) => {
        report.stage = "fetch";
        lastRawResponse = await fetchHistoryPage(conversationId, cursor);
        report.pagesFetched = pageNumber + 1;
        // L'analyse de la réponse se fait juste après, dans le cœur.
        report.stage = "parse";
        return lastRawResponse;
      });
      report.rawTurnCount = history.rawTurnsNewestFirst.length;

      report.stage = "extract";
      turns = Core.historyToChronologicalTurns(history.rawTurnsNewestFirst);
      report.turnCount = turns.length;

      report.stage = "validate";
      const diagnostics = Core.validateConversation(turns, {
        lenient: preferences.lenient,
      });

      report.stage = "render";
      const markdown = Core.renderMarkdown({
        title,
        sourceUrl: report.url,
        conversationId,
        exportedAt: new Date().toISOString(),
        turns,
        diagnostics,
        includeMetadata: preferences.includeMetadata,
        includeOutline: preferences.includeOutline,
      });

      // Anomalies tolérées : même détail que pour un échec, pour pouvoir
      // affiner plus tard la lecture des contenus non textuels.
      let warnings = null;
      if (diagnostics.problems.length > 0) {
        const problems = diagnostics.problems.map((problem) => {
          const turn = turns[problem.turn - 1];
          return {
            ...problem,
            hint: Core.PROBLEM_HINTS[problem.kind] || null,
            extras: turn?.extras,
            rawTurn: Core.describeValue(
              history.rawTurnsNewestFirst[problem.sourceIndex],
            ),
          };
        });
        warnings = { summary: failureSummary({ problems }), problems };
        console.groupCollapsed(
          `[Gemini Exporter] ⚠ ${title}: exported with warnings, ${warnings.summary}`,
        );
        for (const problem of problems) {
          console.warn(`turn ${problem.turn}: ${problem.kind}. ${problem.hint || ""}`, problem);
        }
        console.groupEnd();
      }

      return {
        markdown,
        turns,
        diagnostics,
        warnings,
        pages: history.pages.length,
      };
    } catch (error) {
      report.message = errorMessage(error);
      if (error?.httpStatus) {
        report.httpStatus = error.httpStatus;
        report.responsePreview = error.responsePreview;
      } else if (report.stage === "parse") {
        report.responsePreview = lastRawResponse.slice(0, 500);
      }
      if (Array.isArray(error?.problems) && history && turns) {
        report.problems = error.problems.map((problem) => {
          const turn = turns[problem.turn - 1];
          return {
            ...problem,
            hint: Core.PROBLEM_HINTS[problem.kind] || null,
            timestamp: turn?.timestamp || null,
            userPreview: Core.turnPreview(turn?.userMarkdown || "", 120),
            geminiPreview: Core.turnPreview(turn?.assistantMarkdown || "", 120),
            rawTurn: Core.describeValue(
              history.rawTurnsNewestFirst[problem.sourceIndex],
            ),
          };
        });
        report.problemKinds = [
          ...new Set(report.problems.map((problem) => problem.kind)),
        ];
      }
      if (error?.stack) {
        report.stack = String(error.stack).split("\n").slice(0, 6).join("\n");
      }

      const wrapped = new Error(report.message);
      wrapped.report = report;
      throw wrapped;
    }
  }

  function logExportFailure(error) {
    const report = error?.report || { message: errorMessage(error) };
    console.groupCollapsed(
      `[Gemini Exporter] ✗ ${report.title || report.conversationId || "conversation"} (stage: ${report.stage || "?"}) ${report.message}`,
    );
    for (const problem of report.problems || []) {
      console.warn(
        `turn ${problem.turn}: ${problem.kind}. ${problem.hint || ""}`,
        problem,
      );
    }
    console.log("Full report", report);
    console.groupEnd();
    return report;
  }

  // Version courte affichée dans l'infobulle de la liste.
  function failureSummary(report) {
    if (report.problems?.length) {
      const turnsByKind = new Map();
      for (const problem of report.problems) {
        turnsByKind.set(problem.kind, [
          ...(turnsByKind.get(problem.kind) || []),
          problem.turn,
        ]);
      }
      return [...turnsByKind]
        .map(([kind, turnNumbers]) => `${kind} (turn ${turnNumbers.join(", ")})`)
        .join("; ");
    }
    return `${report.stage || "?"}: ${report.message}`;
  }

  function downloadBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }

  function downloadMarkdown(markdown, filename) {
    downloadBlob(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      filename,
    );
  }

  // ---- Lecture de la liste des conversations dans la barre latérale ----

  function sidebarTitle(element) {
    const titled =
      element.querySelector(".conversation-title, [class*='title']") ||
      element;
    return (titled.textContent || "").replace(/\s+/g, " ").trim();
  }

  function readSidebarConversations() {
    const found = new Map();
    const candidates = document.querySelectorAll(
      'a[href*="/app/"], [data-test-id="conversation"], .conversation[jslog]',
    );

    for (const element of candidates) {
      if (element.closest(`#${ROOT_ID}`)) {
        continue;
      }

      const conversationId =
        Core.conversationIdFromReference(element.getAttribute("href")) ||
        Core.conversationIdFromReference(element.getAttribute("jslog")) ||
        Core.conversationIdFromReference(
          element.querySelector("[jslog]")?.getAttribute("jslog"),
        );
      if (!conversationId || found.has(conversationId)) {
        continue;
      }

      found.set(conversationId, {
        id: conversationId,
        title: sidebarTitle(element) || "Gemini conversation",
        element,
      });
    }

    return [...found.values()];
  }

  function scrollableAncestor(element) {
    for (let node = element?.parentElement; node; node = node.parentElement) {
      const overflowY = getComputedStyle(node).overflowY;
      if (
        /(auto|scroll)/.test(overflowY) &&
        node.scrollHeight > node.clientHeight + 10
      ) {
        return node;
      }
    }
    return null;
  }

  function clickShowMore() {
    const buttons = document.querySelectorAll(
      '[data-test-id="show-more-button"], button, [role="button"]',
    );
    for (const button of buttons) {
      if (button.closest(`#${ROOT_ID}`)) {
        continue;
      }
      const label = (button.textContent || "").replace(/\s+/g, " ").trim();
      if (
        button.matches('[data-test-id="show-more-button"]') ||
        /^(show more|afficher plus|voir plus)$/i.test(label)
      ) {
        button.click();
        return true;
      }
    }
    return false;
  }

  // Fait défiler la barre latérale jusqu'à disposer d'au moins targetCount
  // conversations : Gemini charge l'historique par pages au fil du scroll.
  // exhausted indique que la barre latérale n'a plus rien à charger.
  async function loadSidebarConversations(
    targetCount,
    { onProgress, shouldStop },
  ) {
    let conversations = readSidebarConversations();
    if (conversations.length === 0) {
      clickShowMore();
      await sleep(SIDEBAR_SCROLL_WAIT_MS);
      conversations = readSidebarConversations();
    }
    if (conversations.length === 0) {
      throw new Error(
        "No conversation found in the sidebar. Open Gemini's side menu and try again.",
      );
    }

    let stableRounds = 0;
    for (
      let round = 0;
      round < SIDEBAR_MAX_ROUNDS &&
      stableRounds < SIDEBAR_STABLE_ROUNDS &&
      conversations.length < targetCount;
      round += 1
    ) {
      if (shouldStop()) {
        break;
      }

      const last = conversations[conversations.length - 1].element;
      const container = scrollableAncestor(last);
      last.scrollIntoView({ block: "end" });
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
      clickShowMore();
      await sleep(SIDEBAR_SCROLL_WAIT_MS);

      const next = readSidebarConversations();
      stableRounds = next.length > conversations.length ? 0 : stableRounds + 1;
      conversations = next;
      onProgress(conversations.length);
    }

    return {
      conversations: conversations.map(({ id, title }) => ({ id, title })),
      exhausted: stableRounds >= SIDEBAR_STABLE_ROUNDS,
    };
  }

  const STYLES = `
    :host {
      all: initial;
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 2147483647;
      font-family: "Google Sans", system-ui, -apple-system, sans-serif;
    }

    .stack {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 10px;
    }

    button,
    input {
      font: inherit;
    }

    button {
      appearance: none;
      border: 0;
      cursor: pointer;
    }

    .control {
      display: flex;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 999px;
      background: #1f1f1f;
      color: #fff;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
    }

    .export-button,
    .menu-button {
      display: inline-flex;
      min-height: 42px;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: inherit;
    }

    .export-button {
      gap: 8px;
      min-width: 142px;
      padding: 0 16px;
      font-weight: 650;
      white-space: nowrap;
      transition: min-width 120ms ease, padding 120ms ease;
    }

    .download-icon {
      font-size: 18px;
      line-height: 1;
    }

    .menu-button {
      width: 38px;
      border-left: 1px solid rgba(255, 255, 255, 0.16);
      font-size: 21px;
      line-height: 1;
    }

    .control[data-collapsed="true"] .export-button {
      min-width: 42px;
      padding: 0 12px;
    }

    .control[data-collapsed="true"] .export-label {
      display: none;
    }

    .export-button:hover,
    .menu-button:hover {
      background: #303030;
    }

    button:focus-visible {
      outline: 3px solid #a8c7fa;
      outline-offset: -3px;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .panel {
      box-sizing: border-box;
      width: min(280px, calc(100vw - 32px));
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 14px;
      background: #1f1f1f;
      color: #fff;
      padding: 14px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.34);
    }

    .panel[hidden] {
      display: none;
    }

    .panel-heading {
      margin: 0 0 10px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .panel-heading-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }

    .version {
      color: #9aa0a6;
      font-size: 11px;
      font-weight: 500;
    }

    .option {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      border-radius: 9px;
      cursor: pointer;
      padding: 8px 6px;
    }

    .option:hover {
      background: rgba(255, 255, 255, 0.07);
    }

    .option input,
    .row input {
      width: 16px;
      height: 16px;
      margin: 1px 0 0;
      accent-color: #a8c7fa;
    }

    .option-copy {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 3px;
    }

    .option-label {
      font-size: 13px;
      font-weight: 650;
      line-height: 1.2;
    }

    .option-description {
      color: #c7c7c7;
      font-size: 11px;
      font-weight: 450;
      line-height: 1.35;
    }

    .action-button {
      border-radius: 9px;
      background: #303030;
      color: #fff;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 650;
      white-space: nowrap;
    }

    .action-button.primary {
      background: #a8c7fa;
      color: #062e6f;
    }

    .action-button:hover:not(:disabled) {
      filter: brightness(1.12);
    }

    .panel .action-button {
      width: 100%;
      margin-top: 10px;
    }

    .compact-toggle {
      width: 100%;
      margin-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.14);
      background: transparent;
      color: #a8c7fa;
      padding: 12px 6px 3px;
      text-align: left;
      font-size: 12px;
      font-weight: 650;
    }

    .compact-toggle:hover {
      color: #d3e3fd;
    }

    .toast {
      box-sizing: border-box;
      display: none;
      max-width: min(420px, calc(100vw - 44px));
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 12px;
      background: #1f1f1f;
      color: #fff;
      font: 500 13px/1.45 system-ui, -apple-system, sans-serif;
      padding: 11px 13px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.28);
      white-space: pre-line;
    }

    .toast[data-kind="error"] {
      background: #8c1d18;
    }

    /* ---- Fenêtre de sélection des conversations ---- */

    .overlay {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.55);
    }

    .overlay[hidden] {
      display: none;
    }

    .dialog {
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      width: min(680px, calc(100vw - 32px));
      height: min(760px, calc(100vh - 48px));
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 16px;
      background: #1f1f1f;
      color: #fff;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
    }

    .dialog-header,
    .dialog-toolbar,
    .dialog-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 12px 16px;
    }

    .dialog-header {
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    .dialog-title {
      margin: 0;
      font-size: 16px;
      font-weight: 700;
    }

    .close-button {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: transparent;
      color: #fff;
      font-size: 20px;
      line-height: 1;
    }

    .close-button:hover:not(:disabled) {
      background: #303030;
    }

    .filter-input {
      box-sizing: border-box;
      flex: 1 1 180px;
      min-width: 0;
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 9px;
      background: #2a2a2a;
      color: #fff;
      padding: 7px 10px;
      font-size: 13px;
    }

    .inline-check {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      color: #c7c7c7;
      font-size: 12px;
      cursor: pointer;
    }

    .inline-check input {
      accent-color: #a8c7fa;
    }

    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }

    .row {
      display: grid;
      grid-template-columns: 20px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 8px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      cursor: pointer;
    }

    .row:hover {
      background: rgba(255, 255, 255, 0.05);
    }

    .row[data-status="active"] {
      background: rgba(168, 199, 250, 0.16);
    }

    .row-title {
      overflow: hidden;
      font-size: 13px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .row-badge {
      color: #9aa0a6;
      font-size: 11px;
      white-space: nowrap;
    }

    .row[data-status="done"] .row-badge,
    .row[data-badge="exported"] .row-badge {
      color: #6dd58c;
    }

    .row[data-badge="updated"] .row-badge {
      color: #fdd663;
    }

    .row[data-status="failed"] .row-badge,
    .row[data-badge="failed"] .row-badge {
      color: #f2b8b5;
    }

    .row[data-status="active"] .row-badge {
      color: #a8c7fa;
    }

    .list-footer {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      padding: 14px 16px;
      color: #9aa0a6;
      font-size: 12px;
    }

    .empty {
      padding: 32px 16px;
      color: #9aa0a6;
      font-size: 13px;
      text-align: center;
    }

    .progress {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 12px 16px 0;
    }

    .progress[hidden] {
      display: none;
    }

    .progress-track {
      overflow: hidden;
      height: 8px;
      border-radius: 999px;
      background: #303030;
    }

    .progress-fill {
      width: 0;
      height: 100%;
      border-radius: inherit;
      background: #a8c7fa;
      transition: width 240ms ease;
    }

    .progress-text {
      overflow: hidden;
      color: #e3e3e3;
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .progress-counts {
      color: #9aa0a6;
      font-size: 11px;
    }

    .dialog-footer {
      justify-content: space-between;
    }

    .footer-actions {
      display: flex;
      gap: 8px;
      margin-left: auto;
    }

    @media (max-width: 520px) {
      :host {
        right: 12px;
        bottom: 12px;
      }
    }
  `;

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function createActionButton(label, className = "action-button") {
    const button = createElement("button", className, label);
    button.type = "button";
    return button;
  }

  function createOption({ label, description, checked, onChange }) {
    const option = createElement("label", "option");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));

    const copy = createElement("span", "option-copy");
    copy.append(
      createElement("span", "option-label", label),
      createElement("span", "option-description", description),
    );
    option.append(input, copy);
    return { option, input };
  }

  function formatDate(isoString) {
    const date = new Date(isoString);
    return Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  function createUi() {
    const preferences = {
      collapsed: readBooleanPreference(PREFERENCE_KEYS.collapsed, false),
      includeMetadata: readBooleanPreference(
        PREFERENCE_KEYS.includeMetadata,
        true,
      ),
      includeOutline: readBooleanPreference(
        PREFERENCE_KEYS.includeOutline,
        true,
      ),
      batchAsZip: readBooleanPreference(PREFERENCE_KEYS.batchAsZip, true),
      lenient: readBooleanPreference(PREFERENCE_KEYS.lenient, true),
    };
    const state = {
      catalog: readPreference(PREFERENCE_KEYS.batchCatalog, [], Array.isArray),
      exported: readObjectPreference(PREFERENCE_KEYS.batchExported),
      failed: readObjectPreference(PREFERENCE_KEYS.batchFailed),
      selected: new Set(),
      // Statut de chaque conversation pendant l'export en cours :
      // queued, active, done ou failed.
      runStatus: new Map(),
      // Conversations exportées avec avertissements pendant l'export en cours.
      runWarnings: new Map(),
      // Nature de l'opération en cours : "export" ou "check".
      runKind: null,
      displayLimit: 0,
      sidebarExhausted: false,
      loading: false,
      running: false,
      stopRequested: false,
    };

    const host = document.createElement("div");
    host.id = ROOT_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLES;

    const stack = createElement("div", "stack");
    const toast = createElement("div", "toast");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    // ---- Panneau d'options ----

    const panel = createElement("div", "panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Export options");

    const outlineOption = createOption({
      label: "Conversation outline",
      description: "Linked turn list with short prompt previews",
      checked: preferences.includeOutline,
      onChange(value) {
        preferences.includeOutline = value;
        writeBooleanPreference(PREFERENCE_KEYS.includeOutline, value);
      },
    });
    const metadataOption = createOption({
      label: "Export metadata",
      description: "Source, export details, validation and turn IDs",
      checked: preferences.includeMetadata,
      onChange(value) {
        preferences.includeMetadata = value;
        writeBooleanPreference(PREFERENCE_KEYS.includeMetadata, value);
      },
    });
    const lenientOption = createOption({
      label: "Tolerant export",
      description:
        "Export even when a turn has no text (image, Canvas…), with a warning and attachments",
      checked: preferences.lenient,
      onChange(value) {
        preferences.lenient = value;
        writeBooleanPreference(PREFERENCE_KEYS.lenient, value);
      },
    });
    const openPickerButton = createActionButton(
      "Export several conversations…",
      "action-button primary",
    );
    const compactToggle = createActionButton("", "compact-toggle");
    const panelHeadingRow = createElement("div", "panel-heading-row");
    panelHeadingRow.append(createElement("p", "panel-heading", "Export options"));
    if (SCRIPT_VERSION) {
      panelHeadingRow.append(
        createElement("span", "version", `v${SCRIPT_VERSION}`),
      );
    }

    panel.append(
      panelHeadingRow,
      outlineOption.option,
      metadataOption.option,
      lenientOption.option,
      openPickerButton,
      compactToggle,
    );

    // ---- Bouton principal ----

    const control = createElement("div", "control");
    const exportButton = createActionButton("", "export-button");
    exportButton.setAttribute("aria-label", "Export Markdown");
    const downloadIcon = createElement("span", "download-icon", "↓");
    downloadIcon.setAttribute("aria-hidden", "true");
    const exportLabel = createElement("span", "export-label", "Export Markdown");
    exportButton.append(downloadIcon, exportLabel);

    const menuButton = createActionButton("⋮", "menu-button");
    menuButton.setAttribute("aria-label", "Export options");
    menuButton.setAttribute("aria-haspopup", "dialog");
    menuButton.setAttribute("aria-expanded", "false");
    control.append(exportButton, menuButton);

    // ---- Fenêtre de sélection ----

    const overlay = createElement("div", "overlay");
    overlay.hidden = true;
    const dialog = createElement("div", "dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Export conversations");

    const header = createElement("div", "dialog-header");
    const closeButton = createActionButton("×", "close-button");
    closeButton.setAttribute("aria-label", "Close");
    header.append(
      createElement("p", "dialog-title", "Export conversations"),
      closeButton,
    );

    const toolbar = createElement("div", "dialog-toolbar");
    const filterInput = document.createElement("input");
    filterInput.type = "search";
    filterInput.className = "filter-input";
    filterInput.placeholder = "Filter loaded conversations by title";
    const selectAllButton = createActionButton("Select shown");
    const clearButton = createActionButton("Clear");
    const hideExportedLabel = createElement("label", "inline-check");
    const hideExportedInput = document.createElement("input");
    hideExportedInput.type = "checkbox";
    hideExportedLabel.append(hideExportedInput, "Hide exported");
    const refreshButton = createActionButton("Refresh");
    refreshButton.title =
      "Reread the sidebar from the top to pick up new conversations";
    const checkButton = createActionButton("Check for new messages");
    checkButton.title =
      "For exported conversations in the list, look for messages added since the export";
    const selectUpdatedButton = createActionButton("");
    toolbar.append(
      filterInput,
      selectAllButton,
      clearButton,
      hideExportedLabel,
      refreshButton,
      checkButton,
      selectUpdatedButton,
    );

    const list = createElement("div", "list");
    const rows = createElement("div");
    const listFooter = createElement("div", "list-footer");
    const listInfo = createElement("span");
    const loadMoreButton = createActionButton(`Load ${LIST_PAGE_SIZE} more`);
    listFooter.append(listInfo, loadMoreButton);
    list.append(rows, listFooter);

    const progress = createElement("div", "progress");
    progress.hidden = true;
    const progressTrack = createElement("div", "progress-track");
    const progressFill = createElement("div", "progress-fill");
    progressTrack.append(progressFill);
    progressTrack.setAttribute("role", "progressbar");
    progressTrack.setAttribute("aria-valuemin", "0");
    const progressText = createElement("div", "progress-text");
    const progressCounts = createElement("div", "progress-counts");
    progress.append(progressText, progressTrack, progressCounts);

    const footer = createElement("div", "dialog-footer");
    const zipLabel = createElement("label", "inline-check");
    const zipInput = document.createElement("input");
    zipInput.type = "checkbox";
    zipInput.checked = preferences.batchAsZip;
    zipLabel.append(zipInput, "Single ZIP file");
    const reportButton = createActionButton("");
    reportButton.title =
      "Download a JSON file describing every failed conversation";
    const stopButton = createActionButton("Stop");
    const runButton = createActionButton("", "action-button primary");
    const footerActions = createElement("div", "footer-actions");
    footerActions.append(reportButton, stopButton, runButton);
    footer.append(zipLabel, footerActions);

    dialog.append(header, toolbar, list, progress, footer);
    overlay.append(dialog);

    stack.append(toast, panel, control);
    shadow.append(style, stack, overlay);

    let toastTimer = null;

    function showToast(message, kind = "success", duration = 8_000) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.dataset.kind = kind;
      toast.style.display = "block";
      toastTimer = setTimeout(() => {
        toast.style.display = "none";
      }, duration);
    }

    function setPanelOpen(open) {
      panel.hidden = !open;
      menuButton.setAttribute("aria-expanded", String(open));
    }

    function setCollapsed(collapsed, persist = true) {
      preferences.collapsed = collapsed;
      control.dataset.collapsed = String(collapsed);
      const versionSuffix = SCRIPT_VERSION ? ` (v${SCRIPT_VERSION})` : "";
      exportButton.title = `Export Markdown${versionSuffix}`;
      compactToggle.textContent = collapsed
        ? "Use expanded control"
        : "Use compact control";

      if (persist) {
        writeBooleanPreference(PREFERENCE_KEYS.collapsed, collapsed);
      }
    }

    function saveState() {
      writePreference(PREFERENCE_KEYS.batchCatalog, state.catalog);
      writePreference(PREFERENCE_KEYS.batchExported, state.exported);
      writePreference(PREFERENCE_KEYS.batchFailed, state.failed);
    }

    // Ordre de la barre latérale en tête (plus récentes d'abord), puis les
    // conversations déjà connues qui ne sont plus dans le DOM.
    function mergeIntoCatalog(fromSidebar, { replace = false } = {}) {
      const merged = fromSidebar.map(({ id, title }) => ({ id, title }));
      if (!replace) {
        const seen = new Set(merged.map((conversation) => conversation.id));
        for (const conversation of state.catalog) {
          if (!seen.has(conversation.id)) {
            merged.push(conversation);
          }
        }
      }
      state.catalog = merged;
      saveState();
    }

    function visibleConversations() {
      const filter = filterInput.value.trim().toLowerCase();
      return state.catalog
        .slice(0, state.displayLimit)
        .filter(
          (conversation) =>
            (!filter || conversation.title.toLowerCase().includes(filter)) &&
            // Une conversation à réexporter reste visible.
            !(hideExportedInput.checked && state.exported[conversation.id] &&
              !state.exported[conversation.id].newMessagesAt &&
              !state.runStatus.has(conversation.id)),
        );
    }

    function badgeFor(conversation) {
      const status = state.runStatus.get(conversation.id);
      if (status === "queued") {
        return ["", "Queued"];
      }
      if (status === "active") {
        return ["", state.runKind === "check" ? "Checking…" : "Exporting…"];
      }
      if (status === "done") {
        return state.runWarnings.has(conversation.id)
          ? ["", "⚠ Exported with warnings"]
          : ["", "✓ Exported"];
      }
      const failure = state.failed[conversation.id];
      if (status === "failed") {
        return ["", `✗ ${shortCause(failure)}`];
      }

      const exported = state.exported[conversation.id];
      if (exported?.newMessagesAt) {
        return ["updated", `New messages since ${formatDate(exported.at)}`];
      }
      if (exported) {
        return [
          "exported",
          `${exported.warnings ? "⚠ " : ""}Exported ${formatDate(exported.at)}`,
        ];
      }
      if (failure) {
        return ["failed", `✗ ${shortCause(failure)}`];
      }
      return ["", ""];
    }

    const SHORT_CAUSES = {
      "missing-user-message": "no prompt text",
      "missing-gemini-response": "no answer text",
      "duplicate-response-id": "duplicate turn",
      "branch-discontinuity": "edited branch",
    };

    function shortCause(failure) {
      const report = failure?.report;
      if (!report) {
        return "Failed";
      }
      const kind = report.problemKinds?.[0];
      if (kind) {
        const turnNumbers = report.problems
          .filter((problem) => problem.kind === kind)
          .map((problem) => problem.turn);
        return `${SHORT_CAUSES[kind] || kind} (turn ${turnNumbers.slice(0, 3).join(", ")}${
          turnNumbers.length > 3 ? "…" : ""
        })`;
      }
      if (report.httpStatus) {
        return `HTTP ${report.httpStatus}`;
      }
      return `${report.stage} error`;
    }

    function failureTooltip(failure) {
      const report = failure.report;
      if (!report) {
        return failure.message;
      }
      const hints = [
        ...new Set((report.problems || []).map((problem) => problem.hint).filter(Boolean)),
      ];
      return [failure.summary || report.message, ...hints, report.message]
        .filter(Boolean)
        .join("\n");
    }

    function renderRow(conversation) {
      const row = createElement("label", "row");
      row.dataset.id = conversation.id;
      const status = state.runStatus.get(conversation.id);
      if (status) {
        row.dataset.status = status;
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(conversation.id);
      checkbox.disabled = state.running;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          state.selected.add(conversation.id);
        } else {
          state.selected.delete(conversation.id);
        }
        renderControls();
      });

      const title = createElement("span", "row-title", conversation.title);
      title.title = conversation.title;
      const [badgeKind, badgeText] = badgeFor(conversation);
      if (badgeKind) {
        row.dataset.badge = badgeKind;
      }
      const badge = createElement("span", "row-badge", badgeText);
      const failure = state.failed[conversation.id];
      const warnings =
        state.runWarnings.get(conversation.id) ||
        state.exported[conversation.id]?.warnings;
      if (failure && !state.exported[conversation.id]) {
        badge.title = failureTooltip(failure);
      } else if (warnings) {
        badge.title = `${warnings}\nSee the warnings at the top of the Markdown file.`;
      }

      row.append(checkbox, title, badge);
      return row;
    }

    function renderList() {
      const scrollTop = list.scrollTop;
      const visible = visibleConversations();

      if (visible.length === 0) {
        rows.replaceChildren(
          createElement(
            "div",
            "empty",
            state.loading
              ? "Loading conversations from the sidebar…"
              : state.catalog.length === 0
                ? "No conversation loaded. Open Gemini's side menu, then Refresh."
                : "No conversation matches.",
          ),
        );
      } else {
        rows.replaceChildren(...visible.map(renderRow));
      }
      list.scrollTop = scrollTop;
      renderControls();
    }

    function renderControls() {
      const shown = Math.min(state.displayLimit, state.catalog.length);
      const canLoadMore =
        state.catalog.length > state.displayLimit || !state.sidebarExhausted;

      listInfo.textContent = state.loading
        ? `Loading… ${state.catalog.length} conversations found`
        : `${shown} conversations shown${
            canLoadMore ? "" : " (end of history)"
          }`;
      loadMoreButton.hidden = !canLoadMore;
      loadMoreButton.disabled = state.loading || state.running;

      const busy = state.loading || state.running;
      runButton.textContent = state.running
        ? state.runKind === "check"
          ? "Checking…"
          : "Exporting…"
        : `Export ${state.selected.size} selected`;
      runButton.disabled = busy || state.selected.size === 0;
      stopButton.hidden = !state.running;
      stopButton.disabled = state.stopRequested;
      const updatedCount = updatedConversations().length;
      checkButton.disabled = busy;
      selectUpdatedButton.hidden = updatedCount === 0;
      selectUpdatedButton.textContent = `Select updated (${updatedCount})`;
      selectUpdatedButton.disabled = busy;
      const failedCount = Object.keys(state.failed).length;
      reportButton.hidden = failedCount === 0;
      reportButton.textContent = `Error report (${failedCount})`;
      reportButton.disabled = state.running;
      closeButton.disabled = state.running;
      refreshButton.disabled = busy;
      selectAllButton.disabled = busy;
      clearButton.disabled = busy || state.selected.size === 0;
      filterInput.disabled = state.running;
      hideExportedInput.disabled = state.running;
      zipInput.disabled = state.running;
    }

    async function loadMore({ replace = false } = {}) {
      const target = state.displayLimit + LIST_PAGE_SIZE;
      const needsSidebar =
        replace || (state.catalog.length < target && !state.sidebarExhausted);

      if (needsSidebar) {
        state.loading = true;
        renderList();
        try {
          const result = await loadSidebarConversations(target, {
            onProgress(count) {
              listInfo.textContent = `Loading… ${count} conversations found in the sidebar`;
            },
            shouldStop: () => overlay.hidden,
          });
          state.sidebarExhausted = result.exhausted;
          mergeIntoCatalog(result.conversations, { replace });
        } catch (error) {
          console.error("[Gemini Exporter] Sidebar loading failed", error);
          showToast(`Could not list conversations: ${errorMessage(error)}`, "error", 15_000);
          state.sidebarExhausted = true;
        } finally {
          state.loading = false;
        }
      }

      state.displayLimit = target;
      renderList();
    }

    function openPicker() {
      setPanelOpen(false);
      overlay.hidden = false;
      // Les conversations déjà visibles dans la barre latérale passent devant
      // le catalogue mémorisé, sans faire défiler quoi que ce soit.
      const inSidebar = readSidebarConversations();
      if (inSidebar.length > 0) {
        mergeIntoCatalog(inSidebar);
      }
      if (state.displayLimit === 0) {
        loadMore();
      } else {
        renderList();
      }
      filterInput.focus();
    }

    function closePicker() {
      if (state.running) {
        return;
      }
      overlay.hidden = true;
      state.runStatus.clear();
      progress.hidden = true;
    }

    function setProgress({ index, total, current, done, failed, countsText }) {
      const percent = total === 0 ? 0 : Math.round((index / total) * 100);
      progressFill.style.width = `${percent}%`;
      progressTrack.setAttribute("aria-valuemax", String(total));
      progressTrack.setAttribute("aria-valuenow", String(index));
      progressText.textContent = current
        ? `${Math.min(index + 1, total)} / ${total}  ·  ${current}`
        : `${index} / ${total}`;
      progressCounts.textContent =
        countsText || `${done} exported · ${failed} failed`;
    }

    function scrollRowIntoView(conversationId) {
      const row = rows.querySelector(`[data-id="${conversationId}"]`);
      row?.scrollIntoView({ block: "nearest" });
    }

    // Rapport JSON de tous les échecs mémorisés, regroupés par cause. Il
    // contient des extraits tronqués des messages : à relire avant de le
    // partager.
    function downloadErrorReport() {
      const titles = new Map(
        state.catalog.map((conversation) => [conversation.id, conversation.title]),
      );
      const failures = Object.entries(state.failed).map(([id, failure]) => ({
        conversationId: id,
        title: titles.get(id) || failure.report?.title || null,
        failedAt: failure.at,
        summary: failure.summary || failure.message,
        report: failure.report || { message: failure.message },
      }));
      const byCause = {};
      for (const failure of failures) {
        const kinds = failure.report.problemKinds?.length
          ? failure.report.problemKinds
          : [`${failure.report.stage || "unknown"}-error`];
        for (const kind of kinds) {
          byCause[kind] = (byCause[kind] || 0) + 1;
        }
      }
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "-")
        .slice(0, 15);
      const payload = {
        generatedAt: new Date().toISOString(),
        scriptVersion:
          typeof GM_info !== "undefined" ? GM_info?.script?.version : null,
        failureCount: failures.length,
        byCause,
        hints: Core.PROBLEM_HINTS,
        failures,
      };

      downloadBlob(
        new Blob([JSON.stringify(payload, null, 2)], {
          type: "application/json;charset=utf-8",
        }),
        `gemini-export-errors-${stamp}.json`,
      );
    }

    // Conversations du catalogue signalées comme modifiées depuis leur export.
    function updatedConversations() {
      return state.catalog.filter(
        (conversation) => state.exported[conversation.id]?.newMessagesAt,
      );
    }

    async function checkForNewMessages() {
      // Seulement les conversations exportées de la liste affichée.
      const queue = visibleConversations().filter(
        (conversation) => state.exported[conversation.id],
      );
      if (queue.length === 0) {
        showToast("No exported conversation in the list to check.");
        return;
      }

      state.running = true;
      state.runKind = "check";
      state.stopRequested = false;
      state.runStatus = new Map(queue.map((conversation) => [conversation.id, "queued"]));
      progress.hidden = false;
      let updated = 0;
      let failed = 0;

      try {
        for (let index = 0; index < queue.length; index += 1) {
          if (state.stopRequested) {
            break;
          }

          const conversation = queue[index];
          state.runStatus.set(conversation.id, "active");
          setProgress({
            index,
            total: queue.length,
            current: conversation.title,
            countsText: `${updated} with new messages · ${failed} failed`,
          });
          renderList();
          scrollRowIntoView(conversation.id);

          try {
            const latest = await fetchLatestTurn(conversation.id);
            const record = state.exported[conversation.id];
            if (hasNewMessages(record, latest)) {
              record.newMessagesAt = latest.timestamp || new Date().toISOString();
              updated += 1;
            } else {
              delete record.newMessagesAt;
            }
            saveState();
          } catch (error) {
            failed += 1;
            console.warn(
              `[Gemini Exporter] Could not check ${conversation.title}: ${errorMessage(error)}`,
              error,
            );
          }
          state.runStatus.delete(conversation.id);

          if (index < queue.length - 1 && !state.stopRequested) {
            await sleep(CHECK_DELAY_MS + Math.random() * CHECK_DELAY_JITTER_MS);
          }
        }

        const stopped = state.stopRequested ? " (stopped)" : "";
        setProgress({
          index: queue.length,
          total: queue.length,
          current: "",
          countsText: `${updated} with new messages · ${failed} failed`,
        });
        progressText.textContent = `Check finished${stopped}: ${updated} of ${queue.length} conversations have new messages.`;
      } finally {
        state.running = false;
        state.runKind = null;
        state.stopRequested = false;
        state.runStatus.clear();
        renderList();
      }
    }

    async function runSelectedExport() {
      // On garde l'ordre de la liste, pas l'ordre des clics.
      const queue = state.catalog.filter((conversation) =>
        state.selected.has(conversation.id),
      );
      if (queue.length === 0) {
        return;
      }

      state.running = true;
      state.runKind = "export";
      state.stopRequested = false;
      state.runStatus = new Map(queue.map((conversation) => [conversation.id, "queued"]));
      state.runWarnings = new Map();
      progress.hidden = false;
      const zipFiles = [];
      const usedNames = new Set();
      const failures = [];
      let done = 0;

      function markExported(conversation, result) {
        state.exported[conversation.id] = {
          at: new Date().toISOString(),
          turns: result.turns.length,
          fingerprint: result.diagnostics.fingerprint,
          warnings: result.warnings?.summary || null,
          lastResponseId: result.turns[result.turns.length - 1]?.responseId || null,
          lastTurnAt: result.turns[result.turns.length - 1]?.timestamp || null,
        };
        delete state.failed[conversation.id];
      }

      try {
        for (let index = 0; index < queue.length; index += 1) {
          if (state.stopRequested) {
            break;
          }

          const conversation = queue[index];
          state.runStatus.set(conversation.id, "active");
          setProgress({
            index,
            total: queue.length,
            current: conversation.title,
            done,
            failed: failures.length,
          });
          renderList();
          scrollRowIntoView(conversation.id);

          try {
            const result = await buildConversationExport({
              conversationId: conversation.id,
              title: conversation.title,
              preferences,
            });
            let filename = Core.batchFilename(
              conversation.title,
              conversation.id,
              result.turns[0]?.timestamp,
            );
            while (usedNames.has(filename)) {
              filename = filename.replace(/\.md$/, "-1.md");
            }
            usedNames.add(filename);

            if (preferences.batchAsZip) {
              zipFiles.push({ name: filename, content: result.markdown, conversation, result });
            } else {
              downloadMarkdown(result.markdown, filename);
              markExported(conversation, result);
              saveState();
            }
            done += 1;
            if (result.warnings) {
              state.runWarnings.set(conversation.id, result.warnings.summary);
            }
            state.runStatus.set(conversation.id, "done");
            state.selected.delete(conversation.id);
          } catch (error) {
            const report = logExportFailure(error);
            const summary = failureSummary(report);
            failures.push({ title: conversation.title, summary, report });
            state.failed[conversation.id] = {
              at: new Date().toISOString(),
              message: report.message,
              summary,
              report,
            };
            state.runStatus.set(conversation.id, "failed");
            saveState();
          }

          if (index < queue.length - 1 && !state.stopRequested) {
            await sleep(BATCH_DELAY_MS + Math.random() * BATCH_DELAY_JITTER_MS);
          }
        }

        if (preferences.batchAsZip && zipFiles.length > 0) {
          const stamp = new Date()
            .toISOString()
            .replace(/[-:]/g, "")
            .replace("T", "-")
            .slice(0, 15);
          downloadBlob(
            new Blob(Core.buildZipParts(zipFiles), { type: "application/zip" }),
            `gemini-export-${stamp}-${zipFiles.length}.zip`,
          );
          for (const file of zipFiles) {
            markExported(file.conversation, file.result);
          }
          saveState();
        }

        const processed = done + failures.length;
        const stopped = state.stopRequested ? " (stopped)" : "";
        setProgress({ index: processed, total: queue.length, current: "", done, failed: failures.length });
        const warned = queue.filter((conversation) =>
          state.runWarnings.has(conversation.id),
        ).length;
        progressText.textContent = `Finished${stopped}: ${done} exported${
          warned ? ` (${warned} with warnings)` : ""
        }, ${failures.length} failed.`;

        if (failures.length > 0) {
          // Vue d'ensemble dans la console : un échec par ligne, avec le
          // type d'anomalie, pour repérer d'un coup d'œil un motif commun.
          console.table(
            failures.map(({ title, summary, report }) => ({
              title,
              stage: report.stage,
              cause: summary,
              conversation: report.url,
            })),
          );
          showToast(
            `${failures.length} conversation${failures.length === 1 ? "" : "s"} failed. Hover “✗ Failed” for the cause, or click “Error report”. Details are in the console (F12).\n${failures
              .slice(0, 3)
              .map(({ title, summary }) => `${title}: ${summary}`)
              .join("\n")}`,
            "error",
            20_000,
          );
        }
      } finally {
        state.running = false;
        state.runKind = null;
        state.stopRequested = false;
        renderList();
      }
    }

    exportButton.addEventListener("click", exportCurrentConversation);
    menuButton.addEventListener("click", () => {
      setPanelOpen(panel.hidden);
    });
    compactToggle.addEventListener("click", () => {
      setCollapsed(!preferences.collapsed);
      setPanelOpen(false);
    });
    openPickerButton.addEventListener("click", openPicker);
    closeButton.addEventListener("click", closePicker);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        closePicker();
      }
    });
    filterInput.addEventListener("input", renderList);
    hideExportedInput.addEventListener("change", renderList);
    selectAllButton.addEventListener("click", () => {
      for (const conversation of visibleConversations()) {
        state.selected.add(conversation.id);
      }
      renderList();
    });
    clearButton.addEventListener("click", () => {
      state.selected.clear();
      renderList();
    });
    refreshButton.addEventListener("click", () => {
      state.displayLimit = 0;
      state.sidebarExhausted = false;
      state.runStatus.clear();
      progress.hidden = true;
      loadMore({ replace: true });
    });
    loadMoreButton.addEventListener("click", () => loadMore());
    zipInput.addEventListener("change", () => {
      preferences.batchAsZip = zipInput.checked;
      writeBooleanPreference(PREFERENCE_KEYS.batchAsZip, zipInput.checked);
    });
    runButton.addEventListener("click", runSelectedExport);
    checkButton.addEventListener("click", checkForNewMessages);
    selectUpdatedButton.addEventListener("click", () => {
      for (const conversation of updatedConversations()) {
        state.selected.add(conversation.id);
      }
      renderList();
    });
    reportButton.addEventListener("click", downloadErrorReport);
    stopButton.addEventListener("click", () => {
      state.stopRequested = true;
      stopButton.disabled = true;
      progressCounts.textContent = "Stopping after the current conversation…";
    });

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(host)) {
          setPanelOpen(false);
        }
      },
      true,
    );
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setPanelOpen(false);
        closePicker();
      }
    });

    async function exportCurrentConversation() {
      const conversationId = Core.conversationIdFromPath(location.pathname);
      if (!conversationId) {
        showToast("Open a Gemini conversation before exporting.", "error");
        return;
      }

      setPanelOpen(false);
      exportButton.disabled = true;
      exportButton.setAttribute("aria-label", "Exporting");
      downloadIcon.textContent = "…";
      exportLabel.textContent = "Exporting…";

      try {
        const title = Core.cleanDocumentTitle(document.title);
        const result = await buildConversationExport({
          conversationId,
          title,
          preferences,
        });
        const filename = Core.safeFilename(title);

        downloadMarkdown(result.markdown, filename);
        console.info("[Gemini Exporter] Export complete", {
          filename,
          pages: result.pages,
          ...result.diagnostics,
        });
        showToast(
          `Exported ${result.turns.length} turns from ${result.pages} page${
            result.pages === 1 ? "" : "s"
          }. Validation: ${result.diagnostics.fingerprint}.${
            result.warnings
              ? `\nWarnings: ${result.warnings.summary}. Details in the console (F12).`
              : ""
          }`,
          "success",
          result.warnings ? 15_000 : 8_000,
        );
      } catch (error) {
        const report = logExportFailure(error);
        const hints = [
          ...new Set((report.problems || []).map((problem) => problem.hint).filter(Boolean)),
        ];
        showToast(
          [`Export stopped: ${failureSummary(report)}`, ...hints, "Details in the console (F12)."].join("\n"),
          "error",
          20_000,
        );
      } finally {
        exportButton.disabled = false;
        exportButton.setAttribute("aria-label", "Export Markdown");
        downloadIcon.textContent = "↓";
        exportLabel.textContent = "Export Markdown";
      }
    }

    setCollapsed(preferences.collapsed, false);
    return { host };
  }

  const ui = createUi();
  document.documentElement.append(ui.host);
})();
