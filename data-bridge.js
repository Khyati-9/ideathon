// Expose the imported dataset reliably to the UI script in file:// and hosted-page contexts.
window.importedData = typeof importedData !== 'undefined' ? importedData : { farmers: [], workers: [] };
