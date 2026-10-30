// =============================================================================
// MENU TRIGGER
// =============================================================================

function onOpen() {
  DocsToolsByKutomi.buildMenu();
}

function showSidebar() {
  DocsToolsByKutomi.showSidebar();
}

// =============================================================================
// FRONT-END DELEGATES (Passes google.script.run calls directly to the library)
// =============================================================================

function getDocumentComments() {
  return DocsToolsByKutomi.getDocumentComments();
}

function processCommentBatch(batch) {
  return DocsToolsByKutomi.processCommentBatch(batch);
}

function jumpToCommentText(quotedText, occurrenceIndex) {
  return DocsToolsByKutomi.jumpToCommentText(quotedText, occurrenceIndex);
}