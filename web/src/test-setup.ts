import '@testing-library/jest-dom/vitest'

// jsdom has no modal dialogs, so stand in for the two calls Astryx makes.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}
