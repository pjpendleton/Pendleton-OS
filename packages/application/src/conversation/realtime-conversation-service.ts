import { createHash } from 'node:crypto';
import type { ConversationRuntime } from './conversation-runtime.js';

export interface RealtimeSessionConfiguration {
  readonly type: 'realtime';
  readonly model: string;
  readonly instructions: string;
  readonly audio: {
    readonly input: { readonly transcription: { readonly model: string } };
    readonly output: { readonly voice: string };
  };
  readonly tools: readonly RealtimeFunctionTool[];
  readonly tool_choice: 'auto';
}

export interface RealtimeFunctionTool {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface RealtimeCallRequest {
  readonly sdp: string;
  readonly safetyIdentifier: string;
  readonly session: RealtimeSessionConfiguration;
}

export interface RealtimeCallAnswer {
  readonly sdp: string;
  readonly location?: string;
}

export interface RealtimeSessionProvider {
  createCall(request: RealtimeCallRequest): Promise<RealtimeCallAnswer>;
}

export class RealtimeConversationService {
  constructor(
    private readonly conversations: ConversationRuntime,
    private readonly provider: RealtimeSessionProvider,
    private readonly options: {
      readonly model: string;
      readonly voice: string;
      readonly transcriptionModel: string;
    },
  ) {}

  async connect(sessionId: string, principalId: string, sdp: string): Promise<RealtimeCallAnswer> {
    if (sdp.trim().length < 20) throw new Error('REALTIME_SDP_INVALID');
    const snapshot = await this.conversations.resume(sessionId, principalId);
    if (snapshot.session.status === 'closed') throw new Error('CONVERSATION_CLOSED');
    const drivingInstruction = snapshot.session.drivingMode
      ? 'Driving mode is active. Keep spoken responses brief, lead with the decision or action, and never require visual review while the vehicle is moving.'
      : 'Use a natural conversational pace. Be concise, but provide enough detail to make the next decision clear.';
    const recentContext = snapshot.turns
      .slice(-12)
      .map((turn) => `${turn.role}: ${turn.text}`)
      .join('\n');
    const projectMemory = (
      await this.conversations.projectMemory(principalId, snapshot.session.projectId, 3)
    )
      .map((turn) => turn.text)
      .join('\n\n');
    return this.provider.createCall({
      sdp,
      safetyIdentifier: createHash('sha256').update(principalId).digest('hex'),
      session: {
        type: 'realtime',
        model: this.options.model,
        instructions: [
          'You are the conversational interface for Pendleton OS, serving Peter Pendleton.',
          'Be natural, direct, interruptible, and context-aware. Distinguish discussion from a request to take action.',
          'Never claim an action is complete unless a Pendleton OS tool result confirms it.',
          'Use search_project_knowledge when Peter asks about a project, document, email, decision, status, risk, or prior communication. Ground the answer in returned sources and name the source titles naturally.',
          'If project knowledge search returns partial or unavailable sources, say which source was unavailable. Never invent missing project facts.',
          'Use propose_artifact_create only when Peter clearly asks to save or create a document. The proposal remains subject to server policy and confirmation.',
          'Use capture_follow_up when Peter asks you to remember, track, or follow up on an action. Repeat the captured action and any stated timing after the tool confirms it.',
          'Use list_projects when Peter asks what projects are available, registered, active, or accessible. Read the returned display names naturally and identify the current project.',
          'Use select_project when Peter naturally names a different project. Do not switch projects unless the server confirms one unambiguous active match.',
          drivingInstruction,
          projectMemory.length === 0
            ? ''
            : `Durable memory from prior conversations for this project:\n${projectMemory}`,
          recentContext.length === 0
            ? ''
            : `Recent durable conversation context:\n${recentContext}`,
        ]
          .filter((value) => value.length > 0)
          .join('\n\n'),
        audio: {
          input: { transcription: { model: this.options.transcriptionModel } },
          output: { voice: this.options.voice },
        },
        tools: [
          {
            type: 'function',
            name: 'search_project_knowledge',
            description:
              'Search the active Pendleton OS project across its governed Google Drive documents and connected read-only Gmail and Outlook sources.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                query: {
                  type: 'string',
                  description: 'A concise natural-language project search query.',
                },
                maxResults: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 8,
                  description: 'Maximum combined source results. Use 5 unless more are necessary.',
                },
              },
              required: ['query'],
            },
          },
          {
            type: 'function',
            name: 'propose_artifact_create',
            description:
              'Propose creation of an internal Pendleton OS document. This does not bypass server policy, confirmation, verification, or audit.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', description: 'Document title.' },
                text: { type: 'string', description: 'Complete document text.' },
              },
              required: ['title', 'text'],
            },
          },
          {
            type: 'function',
            name: 'capture_follow_up',
            description:
              'Capture a requested follow-up or action in the active project through Pendleton OS policy, verification, and audit controls.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', description: 'The specific follow-up action.' },
                timing: {
                  type: 'string',
                  description: 'Any date, deadline, or timing Peter stated, in his own words.',
                },
                context: {
                  type: 'string',
                  description: 'Brief supporting context needed to understand the action.',
                },
              },
              required: ['action'],
            },
          },
          {
            type: 'function',
            name: 'list_projects',
            description:
              'List the active projects Peter is authorized to access and identify the current conversation project.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {},
            },
          },
          {
            type: 'function',
            name: 'select_project',
            description:
              'Switch the active conversation to a project Peter names naturally, using the governed project registry and its aliases.',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: {
                  type: 'string',
                  description: 'The project name or alias exactly as Peter expressed it.',
                },
              },
              required: ['alias'],
            },
          },
        ],
        tool_choice: 'auto',
      },
    });
  }
}
