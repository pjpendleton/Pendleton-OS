import type {
  ProjectDocumentKnowledgeSource,
  ProjectKnowledgeItem,
} from '@pendleton-os/application';
import type { GoogleDriveAdapter } from './google-drive-adapter.js';

const excerpt = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 1_600);

export class GoogleDriveKnowledgeSource implements ProjectDocumentKnowledgeSource {
  constructor(private readonly drive: GoogleDriveAdapter) {}

  async search(
    projectId: string,
    query: string,
    maxResults: number,
  ): Promise<readonly ProjectKnowledgeItem[]> {
    const results = await this.drive.search(projectId, query, maxResults);
    return results.map(({ document }) => ({
      provider: 'google-drive',
      kind: 'document',
      sourceId: document.fileId,
      title: document.name,
      excerpt: excerpt(document.text),
      sourceLabel: 'Google Drive',
      canonicalUrl: `https://docs.google.com/document/d/${encodeURIComponent(document.fileId)}/edit`,
    }));
  }
}
