// Release-Builds (babel env "production", siehe babel.config.js): Aufrufe von
// console.log/info/debug/trace entfernen - in logcat landen so keine
// Statusmeldungen mit Metadaten (Kontakt-IDs, Zeiten, Verbindungsdetails).
// console.warn/error bleiben fuer die Fehlersuche. Wie das bekannte
// "transform-remove-console", aber ohne zusaetzliche Abhaengigkeit.
module.exports = function releaseConsole({ types: t }) {
  const WEG = new Set(['log', 'info', 'debug', 'trace']);
  return {
    name: 'malachi-release-console',
    visitor: {
      CallExpression(path) {
        const c = path.node.callee;
        if (!t.isMemberExpression(c) || c.computed) return;
        if (!t.isIdentifier(c.object, { name: 'console' }) || !t.isIdentifier(c.property)) return;
        if (!WEG.has(c.property.name)) return;
        if (path.parentPath.isExpressionStatement()) path.parentPath.remove();
        else path.replaceWith(t.unaryExpression('void', t.numericLiteral(0)));
      },
    },
  };
};
