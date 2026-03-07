/**
 * Action group Lambda handler for GossipGirl agent.
 *
 * Supported actions:
 *   - /get-current-datetime  → returns current UTC ISO timestamp
 *   - /get-agent-info        → returns agent metadata
 */

interface BedrockActionEvent {
  actionGroup: string;
  apiPath: string;
  httpMethod: string;
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
        model: 'eu.anthropic.claude-3-5-haiku-20241022-v1:0',
        version: '1.0.0',
        description: 'AI agent with two-level memory: session (L1) and user/actor (L2)',
      });

    default:
      return buildResponse(actionGroup, apiPath, httpMethod, 400, {
        error: `Unknown action path: ${apiPath}`,
      });
  }
};
