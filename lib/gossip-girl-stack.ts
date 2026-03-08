import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

const BOT_USERNAME = 'gossip_girl_ai_bot'; // Set to your bot's @username (without @)

const CLAUDE_3_5_HAIKU_MODEL_ID = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0';

// OpenAPI schema defining the action group operations
const ACTION_GROUP_SCHEMA = JSON.stringify({
  openapi: '3.0.0',
  info: {
    title: 'GossipGirl Agent Actions',
    version: '1.0.0',
    description: 'Utility actions available to the GossipGirl agent',
  },
  paths: {
    '/get-current-datetime': {
      post: {
        operationId: 'getCurrentDatetime',
        summary: 'Get the current UTC date and time',
        description: 'Returns the current date and time in ISO 8601 format',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', properties: {} },
            },
          },
        },
        responses: {
          '200': {
            description: 'Current datetime',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    datetime: {
                      type: 'string',
                      description: 'ISO 8601 datetime string',
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/get-agent-info': {
      post: {
        operationId: 'getAgentInfo',
        summary: 'Get information about this agent',
        description: 'Returns the agent name, version, and model details',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', properties: {} },
            },
          },
        },
        responses: {
          '200': {
            description: 'Agent information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    model: { type: 'string' },
                    version: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/allow-session': {
      post: {
        operationId: 'allowSession',
        summary: 'Allow a session to use the agent',
        description: 'Registers a session as allowed in the allowlist',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['session_id', 'user_id'],
                properties: {
                  session_id: { type: 'string', description: 'Session UUID to allow' },
                  user_id: { type: 'string', description: 'Owner user ID' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Session allowed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    session_id: { type: 'string' },
                    user_id: { type: 'string' },
                    status: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/block-session': {
      post: {
        operationId: 'blockSession',
        summary: 'Block a session from using the agent',
        description: 'Marks a session as blocked in the allowlist',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['session_id'],
                properties: {
                  session_id: { type: 'string', description: 'Session UUID to block' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Session blocked',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    session_id: { type: 'string' },
                    status: { type: 'string' },
                    message: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/list-allowed-sessions': {
      post: {
        operationId: 'listAllowedSessions',
        summary: 'List allowed sessions',
        description: 'Returns all sessions with status=allowed, optionally filtered by user_id',
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user_id: { type: 'string', description: 'Optional user ID filter' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'List of allowed sessions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: { type: 'array', items: { type: 'object' } },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

export class GossipGirlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // DynamoDB: Session allowlist (single table design)
    // -----------------------------------------------------------------------
    const sessionTable = new dynamodb.Table(this, 'SessionTable', {
      tableName: 'GossipGirl',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    sessionTable.addGlobalSecondaryIndex({
      indexName: 'UserSessionsIndex',
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // -----------------------------------------------------------------------
    // IAM: Action Lambda role
    // -----------------------------------------------------------------------
    const actionLambdaRole = new iam.Role(this, 'ActionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    // -----------------------------------------------------------------------
    // Lambda: Action group handler
    // -----------------------------------------------------------------------
    const actionLambda = new lambdaNodejs.NodejsFunction(this, 'ActionLambda', {
      entry: path.join(__dirname, '../lambda/actions/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      role: actionLambdaRole,
      timeout: cdk.Duration.seconds(30),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        SESSION_TABLE_NAME: sessionTable.tableName,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        // AWS SDK v3 is available in Node.js 20.x Lambda runtime — keep it external
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Action Lambda needs full CRUD on the session table for allowlist management
    sessionTable.grantReadWriteData(actionLambda);

    // Allow Bedrock to invoke the action Lambda
    actionLambda.addPermission('BedrockInvokePermission', {
      principal: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: this.account,
    });

    // -----------------------------------------------------------------------
    // IAM: Bedrock Agent execution role
    // -----------------------------------------------------------------------
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      inlinePolicies: {
        BedrockAgentPolicy: new iam.PolicyDocument({
          statements: [
            // Allow invoking the foundation model via cross-region inference profile
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
              resources: [
                `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
                `arn:aws:bedrock:*:${this.account}:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0`,
              ],
            }),
            // Allow invoking the action Lambda
            new iam.PolicyStatement({
              actions: ['lambda:InvokeFunction'],
              resources: [actionLambda.functionArn],
            }),
          ],
        }),
      },
    });

    // -----------------------------------------------------------------------
    // IAM: AgentCore Memory execution role
    // -----------------------------------------------------------------------
    const memoryRole = new iam.Role(this, 'MemoryRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
      inlinePolicies: {
        MemoryPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: [
                'bedrockagentcore:CreateMemoryEvent',
                'bedrockagentcore:GetMemory',
                'bedrockagentcore:RetrieveMemory',
                'bedrockagentcore:ListMemories',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // -----------------------------------------------------------------------
    // BedrockAgentCore Memory — summary + semantic, 90-day retention
    // Level 2: user/actor-scoped long-term memory (accessed via memoryId = user_id)
    // -----------------------------------------------------------------------
    const agentCoreMemory = new cdk.CfnResource(this, 'AgentCoreMemory', {
      type: 'AWS::BedrockAgentCore::Memory',
      properties: {
        Name: 'gossipGirlMemory',
        Description: 'Two-strategy long-term memory for GossipGirl agent users',
        MemoryExecutionRoleArn: memoryRole.roleArn,
        EventExpiryDuration: 90,
        MemoryStrategies: [
          {
            // Compresses session conversations into concise summaries per user/session
            SummaryMemoryStrategy: {
              Name: 'SummaryStrategy',
              Namespaces: ['/summaries/{actorId}/{sessionId}/'],
            },
          },
          {
            // Extracts and persists factual knowledge per user
            SemanticMemoryStrategy: {
              Name: 'SemanticStrategy',
              Namespaces: ['/facts/{actorId}/'],
            },
          },
        ],
      },
    });

    const memoryId = agentCoreMemory.getAtt('MemoryId').toString();

    // -----------------------------------------------------------------------
    // Bedrock Agent
    // Level 1 session memory: SESSION_SUMMARY (built-in, scoped by sessionId)
    // Level 2 user memory: AgentCore Memory above (scoped by memoryId = user_id)
    // -----------------------------------------------------------------------
    const bedrockAgent = new bedrock.CfnAgent(this, 'BedrockAgent', {
      agentName: 'GossipGirlAgent',
      description: 'AI agent with two-level memory: session (L1) and user/actor (L2)',
      agentResourceRoleArn: agentRole.roleArn,
      foundationModel: CLAUDE_3_5_HAIKU_MODEL_ID,
      idleSessionTtlInSeconds: 1800,
      autoPrepare: true,
      instruction: [
        'You are GossipGirl, a helpful and personalized AI assistant with two levels of memory:',
        '1. Session memory: you remember everything discussed in this conversation.',
        '2. Long-term user memory: you remember past interactions, preferences, and facts about the user across all sessions.',
        'When relevant, reference what you know about the user from previous sessions.',
        'Always be concise, accurate, and warm in your responses.',
        'Use the getCurrentDatetime action when the user asks about the time or date.',
        'Use the getAgentInfo action when asked about yourself.',
        'You have built-in actions to manage who can access this bot — you MUST use them when asked:',
        '- To grant access to a chat: call the allowSession action with session_id (format: tg-<chatId>) and user_id (format: tg-<userId>).',
        '- To revoke access from a chat: call the blockSession action with session_id.',
        '- To list chats that have access: call the listAllowedSessions action, optionally filtered by user_id.',
        'When a user says "allow session", "grant access", "give access to", "block session", or "revoke access",',
        'immediately call the corresponding action — do not say you cannot do this, because you can.',
      ].join(' '),
      memoryConfiguration: {
        enabledMemoryTypes: ['SESSION_SUMMARY'],
        storageDays: 30,
      },
      actionGroups: [
        {
          actionGroupName: 'GossipGirlActions',
          description: 'Utility actions: datetime, agent info, and session allowlist management',
          actionGroupExecutor: {
            lambda: actionLambda.functionArn,
          },
          apiSchema: {
            payload: ACTION_GROUP_SCHEMA,
          },
          actionGroupState: 'ENABLED',
        },
      ],
    });

    bedrockAgent.addDependency(agentCoreMemory);

    // -----------------------------------------------------------------------
    // Bedrock Agent Alias — "live" points to the prepared draft version
    // -----------------------------------------------------------------------
    const bedrockAgentAlias = new bedrock.CfnAgentAlias(this, 'BedrockAgentAlias', {
      agentId: bedrockAgent.attrAgentId,
      agentAliasName: 'live',
      description: 'Production alias for GossipGirl agent',
    });

    bedrockAgentAlias.addDependency(bedrockAgent);

    // -----------------------------------------------------------------------
    // SSM: Webhook secret (non-sensitive, looked up at synth time)
    // Store with: aws ssm put-parameter --name /gossip-girl/telegram-webhook-secret
    //             --value "<SECRET>" --type String --region eu-central-1
    // -----------------------------------------------------------------------
    const webhookSecret = ssm.StringParameter.valueForStringParameter(
      this, '/gossip-girl/telegram-webhook-secret',
    );

    // -----------------------------------------------------------------------
    // Lambda: Telegram processor — calls Bedrock, sends reply via Bot API
    // -----------------------------------------------------------------------
    const processorLambda = new lambdaNodejs.NodejsFunction(this, 'TelegramProcessorLambda', {
      entry: path.join(__dirname, '../lambda/telegram/processor/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(90),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        AGENT_ID: bedrockAgent.attrAgentId,
        AGENT_ALIAS_ID: bedrockAgentAlias.attrAgentAliasId,
        SESSION_TABLE_NAME: sessionTable.tableName,
        BOT_TOKEN_PARAM: '/gossip-girl/telegram-bot-token',
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        externalModules: ['@aws-sdk/*'],
      },
    });

    sessionTable.grantReadWriteData(processorLambda);

    processorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeAgent'],
      resources: [
        `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${bedrockAgent.attrAgentId}/${bedrockAgentAlias.attrAgentAliasId}`,
      ],
    }));

    processorLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/gossip-girl/telegram-bot-token`,
      ],
    }));

    // -----------------------------------------------------------------------
    // Lambda: Telegram webhook receiver — validates secret, fires async invoke
    // -----------------------------------------------------------------------
    const webhookLambda = new lambdaNodejs.NodejsFunction(this, 'TelegramWebhookLambda', {
      entry: path.join(__dirname, '../lambda/telegram/webhook/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(10),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        PROCESSOR_FUNCTION_ARN: processorLambda.functionArn,
        WEBHOOK_SECRET: webhookSecret,
        BOT_USERNAME: BOT_USERNAME,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        externalModules: ['@aws-sdk/*'],
      },
    });

    webhookLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [processorLambda.functionArn],
    }));

    // -----------------------------------------------------------------------
    // Lambda Function URL — public HTTPS endpoint for Telegram webhook
    // -----------------------------------------------------------------------
    const webhookUrl = webhookLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ['https://api.telegram.org'],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['content-type', 'x-telegram-bot-api-secret-token'],
      },
    });

    // -----------------------------------------------------------------------
    // Stack Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'TelegramWebhookUrl', {
      description: 'Register this URL with Telegram: setWebhook?url=<value>&secret_token=<WEBHOOK_SECRET>',
      value: webhookUrl.url,
    });

    new cdk.CfnOutput(this, 'AgentId', {
      description: 'Bedrock Agent ID',
      value: bedrockAgent.attrAgentId,
    });

    new cdk.CfnOutput(this, 'AgentAliasId', {
      description: 'Bedrock Agent Alias ID (live)',
      value: bedrockAgentAlias.attrAgentAliasId,
    });

    new cdk.CfnOutput(this, 'MemoryId', {
      description: 'AgentCore Memory ID for user-level (L2) long-term memory',
      value: memoryId,
    });

    new cdk.CfnOutput(this, 'SessionTableName', {
      description: 'DynamoDB table name for session allowlist',
      value: sessionTable.tableName,
    });
  }
}
