import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

const CLAUDE_3_5_HAIKU_MODEL_ID = 'eu.anthropic.claude-3-haiku-20240307-v1:0';

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
  },
});

export class GossipGirlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
      },
    });

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
                `arn:aws:bedrock:*::foundation-model/anthropic.claude-3-haiku-20240307-v1:0`,
                `arn:aws:bedrock:*:${this.account}:inference-profile/eu.anthropic.claude-3-haiku-20240307-v1:0`,
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
        'You are GossipGirl, a helpful and personalized AI assistant.',
        'You have two levels of memory:',
        '1. Session memory: you remember everything discussed in this conversation.',
        '2. Long-term user memory: you remember past interactions, preferences, and',
        '   facts about the specific user across all their sessions.',
        'When relevant, reference what you know about the user from previous sessions.',
        'Always be concise, accurate, and warm in your responses.',
        'Use the get_current_datetime action when the user asks about the time or date.',
        'Use the get_agent_info action when asked about yourself.',
      ].join(' '),
      memoryConfiguration: {
        enabledMemoryTypes: ['SESSION_SUMMARY'],
        storageDays: 30,
      },
      actionGroups: [
        {
          actionGroupName: 'GossipGirlActions',
          description: 'Utility actions: get current datetime and agent info',
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
    // IAM: Proxy Lambda role
    // -----------------------------------------------------------------------
    const proxyLambdaRole = new iam.Role(this, 'ProxyLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
      inlinePolicies: {
        InvokeAgentPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ['bedrock:InvokeAgent'],
              resources: [
                `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${bedrockAgent.attrAgentId}/${bedrockAgentAlias.attrAgentAliasId}`,
              ],
            }),
          ],
        }),
      },
    });

    // -----------------------------------------------------------------------
    // Lambda: API Gateway proxy
    // Accepts { message, user_id, session_id? } and invokes the Bedrock agent
    // -----------------------------------------------------------------------
    const proxyLambda = new lambdaNodejs.NodejsFunction(this, 'ProxyLambda', {
      entry: path.join(__dirname, '../lambda/proxy/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      role: proxyLambdaRole,
      timeout: cdk.Duration.seconds(60),
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        AGENT_ID: bedrockAgent.attrAgentId,
        AGENT_ALIAS_ID: bedrockAgentAlias.attrAgentAliasId,
        MEMORY_ID: memoryId,
      },
      bundling: {
        minify: true,
        sourceMap: false,
        target: 'es2020',
        // AWS SDK v3 is available in Node.js 20.x Lambda runtime — keep it external
        externalModules: ['@aws-sdk/*'],
      },
    });

    // -----------------------------------------------------------------------
    // API Gateway — open (no auth), internet-accessible REST API
    // POST /chat → ProxyLambda
    // -----------------------------------------------------------------------
    const api = new apigateway.RestApi(this, 'GossipGirlApi', {
      restApiName: 'GossipGirlApi',
      description: 'Internet-facing endpoint for the GossipGirl Bedrock agent',
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL],
      },
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.NONE,
      },
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    const chatResource = api.root.addResource('chat');
    chatResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(proxyLambda, { proxy: true }),
    );

    // -----------------------------------------------------------------------
    // Stack Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      description: 'POST endpoint to chat with the agent: { message, user_id, session_id? }',
      value: `${api.url}chat`,
      exportName: 'GossipGirlApiEndpoint',
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
  }
}
