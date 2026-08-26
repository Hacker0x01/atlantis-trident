const nodeFs = require('fs');

const MARKER = '<!-- atlantis-trident:terraform-plan -->';

function stackSection(stack, body, perStackBudget) {
  const noChanges = body.includes(
    'No changes. Your infrastructure matches the configuration.',
  );
  // A leading "Error:" or Terraform's diagnostic gutter char (╷) means the
  // stack didn't produce a clean plan.
  const errored = /^Error:/m.test(body) || body.includes('╷') || body === '(no plan produced)';
  const emoji = noChanges ? '✅' : errored ? '⚠️' : '📖';
  let shown = body;
  if (shown.length > perStackBudget) shown = shown.slice(0, perStackBudget) + '\n... (truncated)';
  return [
    `<details><summary>${emoji} Stack: <code>${stack}</code></summary>`,
    '',
    '~~~terraform',
    shown,
    '~~~',
    '</details>',
  ].join('\n');
}

function buildComment({ stacks, plansDir, headSha, runUrl, ranAt, fs = nodeFs }) {
  const perStackBudget = Math.max(2000, Math.floor(55000 / stacks.length));
  const sections = stacks.map((stack) => {
    const f = `${plansDir}/${stack}.txt`;
    const body = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '(no plan produced)';
    return stackSection(stack, body, perStackBudget);
  });
  const footer = `_Last updated ${ranAt} for commit ${headSha.slice(0, 7)} · [run](${runUrl})_`;
  return [MARKER, '### Terraform Plan', '', ...sections, '', footer].join('\n');
}

module.exports = { buildComment, stackSection, MARKER };
