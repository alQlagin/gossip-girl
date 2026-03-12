/**
 * Action group Lambda handler for GossipGirl agent.
 *
 * Supported actions:
 *   - /get-current-datetime      → returns current UTC ISO timestamp
 *   - /get-agent-info            → returns agent metadata
 *   - /allow-session             → registers a session as allowed in DynamoDB
 *   - /block-session             → marks a session as blocked in DynamoDB
 *   - /list-allowed-sessions     → lists allowed sessions, optionally by user_id
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);

const SESSION_TABLE_NAME = process.env.SESSION_TABLE_NAME!;

interface BedrockActionEvent {
  actionGroup: string;
  apiPath: string;
  httpMethod: string;
  sessionAttributes?: Record<string, string>;
  requestBody?: {
    content?: {
      'application/json'?: {
        properties?: Array<{ name: string; value: string; type: string }>;
      };
    };
  };
}

interface ActionResponse {
  messageVersion: string;
  response: {
    actionGroup: string;
    apiPath: string;
    httpMethod: string;
    httpStatusCode: number;
    responseBody: {
      'application/json': {
        body: string;
      };
    };
  };
}

function buildResponse(
  actionGroup: string,
  apiPath: string,
  httpMethod: string,
  statusCode: number,
  body: Record<string, unknown>,
): ActionResponse {
  return {
    messageVersion: '1.0',
    response: {
      actionGroup,
      apiPath,
      httpMethod,
      httpStatusCode: statusCode,
      responseBody: {
        'application/json': {
          body: JSON.stringify(body),
        },
      },
    },
  };
}

async function isAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  const res = await ddb.send(new GetCommand({
    TableName: SESSION_TABLE_NAME,
    Key: { PK: 'ADMINS', SK: userId },
  }));
  return !!res.Item;
}

function getProps(event: BedrockActionEvent): Record<string, string> {
  const props: Record<string, string> = {};
  const properties = event.requestBody?.content?.['application/json']?.properties ?? [];
  for (const { name, value } of properties) {
    props[name] = value;
  }
  return props;
}

export const handler = async (event: BedrockActionEvent): Promise<ActionResponse> => {
  const { actionGroup, apiPath, httpMethod } = event;

  switch (apiPath) {
    case '/get-current-datetime':
      return buildResponse(actionGroup, apiPath, httpMethod, 200, {
        datetime: new Date().toISOString(),
        timezone: 'UTC',
      });

    case '/get-agent-info':
      return buildResponse(actionGroup, apiPath, httpMethod, 200, {
        name: 'GossipGirlAgent',
        model: 'not so smart model',
        version: '1.0.0',
        description: 'AI agent with two-level memory: session (L1) and user/actor (L2)',
      });

    case '/allow-session': {
      const requestorId = event.sessionAttributes?.requestorUserId ?? '';
      if (!(await isAdmin(requestorId))) {
        return buildResponse(actionGroup, apiPath, httpMethod, 403, {
          error: 'Unauthorized. Only admins can allow sessions.',
        });
      }
      const { session_id, user_id } = getProps(event);
      if (!session_id || !user_id) {
        return buildResponse(actionGroup, apiPath, httpMethod, 400, {
          error: 'session_id and user_id are required',
        });
      }
      const now = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: SESSION_TABLE_NAME,
        Item: {
          PK: `SESSION#${session_id}`,
          SK: 'METADATA',
          session_id,
          user_id,
          status: 'allowed',
          created_at: now,
          updated_at: now,
          updated_by: user_id,
        },
      }));
      return buildResponse(actionGroup, apiPath, httpMethod, 200, {
        session_id,
        user_id,
        status: 'allowed',
        message: `Session ${session_id} is now allowed for user ${user_id}`,
      });
    }

    case '/block-session': {
      const requestorId = event.sessionAttributes?.requestorUserId ?? '';
      if (!(await isAdmin(requestorId))) {
        return buildResponse(actionGroup, apiPath, httpMethod, 403, {
          error: 'Unauthorized. Only admins can block sessions.',
        });
      }
      const { session_id } = getProps(event);
      if (!session_id) {
        return buildResponse(actionGroup, apiPath, httpMethod, 400, {
          error: 'session_id is required',
        });
      }
      await ddb.send(new UpdateCommand({
        TableName: SESSION_TABLE_NAME,
        Key: { PK: `SESSION#${session_id}`, SK: 'METADATA' },
        UpdateExpression: 'SET #status = :blocked, updated_at = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':blocked': 'blocked',
          ':now': new Date().toISOString(),
        },
      }));
      return buildResponse(actionGroup, apiPath, httpMethod, 200, {
        session_id,
        status: 'blocked',
        message: `Session ${session_id} has been blocked`,
      });
    }

    case '/list-allowed-sessions': {
      const { user_id } = getProps(event);
      let sessions: Record<string, unknown>[];

      if (user_id) {
        const result = await ddb.send(new QueryCommand({
          TableName: SESSION_TABLE_NAME,
          IndexName: 'UserSessionsIndex',
          KeyConditionExpression: 'user_id = :uid',
          FilterExpression: '#status = :allowed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':uid': user_id, ':allowed': 'allowed' },
        }));
        sessions = (result.Items ?? []) as Record<string, unknown>[];
      } else {
        const result = await ddb.send(new ScanCommand({
          TableName: SESSION_TABLE_NAME,
          FilterExpression: '#status = :allowed',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':allowed': 'allowed' },
        }));
        sessions = (result.Items ?? []) as Record<string, unknown>[];
      }

      return buildResponse(actionGroup, apiPath, httpMethod, 200, {
        sessions,
        count: sessions.length,
      });
    }

    default:
      return buildResponse(actionGroup, apiPath, httpMethod, 400, {
        error: `Unknown action path: ${apiPath}`,
      });
  }
};
