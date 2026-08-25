const endpointInput = document.querySelector('#endpoint');
const tokenInput = document.querySelector('#token');
const scanButton = document.querySelector('#scan');
const statusOutput = document.querySelector('#status');

const settings = await chrome.storage.local.get(['endpoint', 'bridgeToken']);
if (typeof settings.endpoint === 'string') endpointInput.value = settings.endpoint;
if (typeof settings.bridgeToken === 'string') tokenInput.value = settings.bridgeToken;

const collectPage = async () => {
  const text = (element) => element?.innerText?.replace(/\s+/g, ' ').trim() ?? '';
  const absolute = (href) => new URL(href, location.origin).href;
  const digest = async (value) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const workspaceButton = [...document.querySelectorAll('button')].find((button) =>
    button.getAttribute('aria-label')?.toLowerCase().includes('profile'),
  );
  const workspaceLabel = text(workspaceButton).split('\n').filter(Boolean).at(-1) || 'ChatGPT';
  const projectMatch = location.pathname.match(/\/g\/(g-p-[^/]+)/);

  if (location.pathname.startsWith('/projects') && projectMatch === null) {
    const rows = [...document.querySelectorAll('[role="row"]')];
    const projects = [];
    for (const row of rows) {
      const cells = row.querySelectorAll('[role="gridcell"]');
      if (cells.length < 1) continue;
      const displayName = text(cells[0]);
      if (!displayName || displayName.toLowerCase() === 'project') continue;
      const link = row.querySelector('a[href*="/g/g-p-"]');
      const keyMatch = link?.getAttribute('href')?.match(/\/g\/(g-p-[^/]+)/);
      const sourceProjectKey = keyMatch?.[1] ?? `name:${await digest(displayName.toLowerCase())}`;
      projects.push({
        sourceProjectKey,
        locatorKind: keyMatch === null || keyMatch === undefined ? 'derived-name' : 'provider-id',
        displayName,
        ...(link === null ? {} : { canonicalUrl: absolute(link.getAttribute('href')) }),
        ...(cells[1] === undefined ? {} : { modifiedLabel: text(cells[1]) }),
        conversations: [],
        sources: [],
      });
    }
    if (projects.length === 0) throw new Error('No project rows were found on this page.');
    return {
      scope: 'project-list',
      observedCollections: ['projects'],
      workspaceLabel,
      projects,
    };
  }

  if (projectMatch === null) throw new Error('Open ChatGPT Projects or one ChatGPT project first.');
  const sourceProjectKey = projectMatch[1];
  const heading = document.querySelector('h1');
  const displayName = text(heading) || document.title.replace(/\s*[-|]\s*ChatGPT.*$/i, '');
  const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]');
  const selectedLabel = text(selectedTab).toLowerCase();
  const conversations = [];
  const sources = [];
  let observedCollections;

  if (selectedLabel.includes('source')) {
    observedCollections = ['sources'];
    const sourceRegion = [...document.querySelectorAll('[role="region"], section, main')].find(
      (element) => text(element).toLowerCase().includes('sources'),
    );
    const buttons = [...(sourceRegion ?? document).querySelectorAll('button')];
    for (const button of buttons) {
      const label = text(button);
      if (!label || /add sources|choose file|source actions/i.test(label)) continue;
      sources.push({
        sourceKey: `source:${await digest(`${sourceProjectKey}:${label}`)}`,
        displayName: label,
        contentAccess: 'metadata-only',
      });
    }
  } else {
    observedCollections = ['conversations'];
    const seen = new Set();
    for (const link of document.querySelectorAll(`a[href*="/g/${sourceProjectKey}/c/"]`)) {
      const href = absolute(link.getAttribute('href'));
      const key = href.match(/\/c\/([^/?#]+)/)?.[1];
      const title = text(link);
      if (!key || !title || seen.has(key)) continue;
      seen.add(key);
      conversations.push({ sourceConversationKey: key, title, canonicalUrl: href });
    }
  }
  return {
    scope: 'project-detail',
    observedCollections,
    workspaceLabel,
    projects: [
      {
        sourceProjectKey,
        locatorKind: 'provider-id',
        displayName,
        canonicalUrl: location.href,
        conversations,
        sources,
      },
    ],
  };
};

scanButton.addEventListener('click', async () => {
  scanButton.disabled = true;
  statusOutput.textContent = 'Scanning the current ChatGPT page…';
  try {
    const endpoint = endpointInput.value.trim().replace(/\/$/, '');
    const bridgeToken = tokenInput.value.trim();
    if (!endpoint.startsWith('https://') || bridgeToken.length < 32) {
      throw new Error('Enter the HTTPS Pendleton OS URL and the scoped bridge token.');
    }
    await chrome.storage.local.set({ endpoint, bridgeToken });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url?.startsWith('https://chatgpt.com/')) {
      throw new Error('The active tab must be chatgpt.com.');
    }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectPage,
    });
    const payload = {
      contractVersion: '1.0.0',
      snapshotKey: crypto.randomUUID(),
      collectorVersion: '1.0.0',
      capturedAt: new Date().toISOString(),
      pageUrl: tab.url,
      ...result,
    };
    const response = await fetch(`${endpoint}/v1/connectors/chatgpt/inventory`, {
      method: 'POST',
      headers: {
        authorization: `Bridge ${bridgeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.errors?.[0]?.code ?? `HTTP ${response.status}`);
    const receipt = body.receipt;
    statusOutput.textContent = `Saved ${receipt.projectCount} project(s), ${receipt.conversationCount} chat(s), and ${receipt.sourceCount} source(s).`;
  } catch (error) {
    statusOutput.textContent = error instanceof Error ? error.message : 'Bridge scan failed.';
  } finally {
    scanButton.disabled = false;
  }
});
