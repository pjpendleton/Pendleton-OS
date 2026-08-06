import { createHash } from 'node:crypto';

export interface DriveDocument {
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: 'application/vnd.google-apps.document';
  readonly parentIds: readonly string[];
  readonly revisionId: string;
  readonly text: string;
}

export interface DriveEvidence {
  readonly provider: 'google-drive';
  readonly operation: 'read' | 'search' | 'create' | 'update';
  readonly fileId: string;
  readonly revisionId: string;
  readonly parentIds: readonly string[];
  readonly contentHash: string;
  readonly observedAt: string;
}

export interface GoogleDriveClient {
  getDocument(fileId: string): Promise<DriveDocument | undefined>;
  searchDocuments(parentFolderId: string, query: string): Promise<readonly DriveDocument[]>;
  createDocument(input: {
    readonly parentFolderId: string;
    readonly name: string;
    readonly text: string;
  }): Promise<DriveDocument>;
  updateDocument(input: {
    readonly fileId: string;
    readonly expectedRevisionId: string;
    readonly text: string;
  }): Promise<DriveDocument>;
}

export interface ProjectDriveRegistry {
  getProjectRoot(projectId: string): Promise<string | undefined>;
}

const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export class GoogleDriveAdapter {
  readonly #client: GoogleDriveClient;
  readonly #projects: ProjectDriveRegistry;
  readonly #now: () => Date;

  constructor(options: {
    client: GoogleDriveClient;
    projects: ProjectDriveRegistry;
    now?: () => Date;
  }) {
    this.#client = options.client;
    this.#projects = options.projects;
    this.#now = options.now ?? (() => new Date());
  }

  async read(
    projectId: string,
    fileId: string,
  ): Promise<{ document: DriveDocument; evidence: DriveEvidence }> {
    const root = await this.#requireRoot(projectId);
    const document = await this.#client.getDocument(fileId);
    if (document === undefined) throw new Error('DRIVE_DOCUMENT_NOT_FOUND');
    this.#assertInProject(document, root);
    return { document, evidence: this.#evidence('read', document) };
  }

  async search(
    projectId: string,
    query: string,
  ): Promise<readonly { document: DriveDocument; evidence: DriveEvidence }[]> {
    const root = await this.#requireRoot(projectId);
    const documents = await this.#client.searchDocuments(root, query);
    return documents.map((document) => {
      this.#assertInProject(document, root);
      return { document, evidence: this.#evidence('search', document) };
    });
  }

  async create(
    projectId: string,
    input: { name: string; text: string },
  ): Promise<{ document: DriveDocument; evidence: DriveEvidence }> {
    const root = await this.#requireRoot(projectId);
    const document = await this.#client.createDocument({
      parentFolderId: root,
      name: input.name,
      text: input.text,
    });
    this.#assertInProject(document, root);
    return { document, evidence: this.#evidence('create', document) };
  }

  async update(
    projectId: string,
    input: { fileId: string; expectedRevisionId: string; text: string },
  ): Promise<{ document: DriveDocument; evidence: DriveEvidence }> {
    if (input.expectedRevisionId.trim().length === 0) throw new Error('DRIVE_REVISION_REQUIRED');
    const current = await this.read(projectId, input.fileId);
    if (current.document.revisionId !== input.expectedRevisionId)
      throw new Error('DRIVE_REVISION_CONFLICT');
    const document = await this.#client.updateDocument(input);
    const root = await this.#requireRoot(projectId);
    this.#assertInProject(document, root);
    if (document.fileId !== input.fileId) throw new Error('DRIVE_IDENTITY_CHANGED');
    return { document, evidence: this.#evidence('update', document) };
  }

  async #requireRoot(projectId: string): Promise<string> {
    const root = await this.#projects.getProjectRoot(projectId);
    if (root === undefined) throw new Error('DRIVE_PROJECT_ROOT_NOT_FOUND');
    return root;
  }

  #assertInProject(document: DriveDocument, root: string): void {
    if (!document.parentIds.includes(root)) throw new Error('DRIVE_PROJECT_BOUNDARY_VIOLATION');
  }

  #evidence(operation: DriveEvidence['operation'], document: DriveDocument): DriveEvidence {
    return {
      provider: 'google-drive',
      operation,
      fileId: document.fileId,
      revisionId: document.revisionId,
      parentIds: document.parentIds,
      contentHash: contentHash(document.text),
      observedAt: this.#now().toISOString(),
    };
  }
}
