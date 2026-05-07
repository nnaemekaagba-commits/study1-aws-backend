import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  aiProvider?: string;
  feedback?: string;
  attachments?: unknown[];
  isIncorrect?: boolean;
}

export interface StoredUser {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface MessageStore {
  listMessages(userId: string): Promise<StoredMessage[]>;
  saveMessage(userId: string, message: StoredMessage): Promise<StoredMessage>;
  updateFeedback(userId: string, messageId: string, feedback: string): Promise<StoredMessage | null>;
  deleteMessages(userId: string): Promise<void>;
  getUserByEmail(email: string): Promise<StoredUser | null>;
  saveUser(user: StoredUser): Promise<StoredUser>;
}

const tableName = process.env.MESSAGES_TABLE;

class MemoryMessageStore implements MessageStore {
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly usersByEmail = new Map<string, StoredUser>();

  async listMessages(userId: string) {
    return [...(this.messages.get(userId) || [])].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
  }

  async saveMessage(userId: string, message: StoredMessage) {
    const currentMessages = this.messages.get(userId) || [];
    const nextMessages = currentMessages.filter((item) => item.id !== message.id);
    nextMessages.push(message);
    this.messages.set(userId, nextMessages);
    return message;
  }

  async updateFeedback(userId: string, messageId: string, feedback: string) {
    const currentMessages = this.messages.get(userId) || [];
    const messageIndex = currentMessages.findIndex((item) => item.id === messageId);

    if (messageIndex < 0) {
      return null;
    }

    const updatedMessage = { ...currentMessages[messageIndex], feedback };
    currentMessages[messageIndex] = updatedMessage;
    this.messages.set(userId, currentMessages);
    return updatedMessage;
  }

  async deleteMessages(userId: string) {
    this.messages.delete(userId);
  }

  async getUserByEmail(email: string) {
    return this.usersByEmail.get(email.toLowerCase()) || null;
  }

  async saveUser(user: StoredUser) {
    this.usersByEmail.set(user.email.toLowerCase(), user);
    return user;
  }
}

class DynamoMessageStore implements MessageStore {
  private readonly client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  async listMessages(userId: string) {
    const response = await this.client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": this.userPartition(userId),
        },
      }),
    );

    return (response.Items || [])
      .map((item) => item.message as StoredMessage)
      .filter(Boolean)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  async saveMessage(userId: string, message: StoredMessage) {
    await this.client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: this.userPartition(userId),
          sk: this.messageSortKey(message.id),
          message,
          timestamp: message.timestamp,
        },
      }),
    );

    return message;
  }

  async updateFeedback(userId: string, messageId: string, feedback: string) {
    const response = await this.client.send(
      new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: this.userPartition(userId),
          sk: this.messageSortKey(messageId),
        },
        UpdateExpression: "SET message.feedback = :feedback",
        ExpressionAttributeValues: {
          ":feedback": feedback,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    return (response.Attributes?.message as StoredMessage | undefined) || null;
  }

  async deleteMessages(userId: string) {
    const messages = await this.listMessages(userId);

    await Promise.all(
      messages.map((message) =>
        this.client.send(
          new DeleteCommand({
            TableName: tableName,
            Key: {
              pk: this.userPartition(userId),
              sk: this.messageSortKey(message.id),
            },
          }),
        ),
      ),
    );
  }

  async getUserByEmail(email: string) {
    const response = await this.client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND sk = :sk",
        ExpressionAttributeValues: {
          ":pk": this.userEmailPartition(email),
          ":sk": "PROFILE",
        },
      }),
    );

    return (response.Items?.[0]?.user as StoredUser | undefined) || null;
  }

  async saveUser(user: StoredUser) {
    await this.client.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: this.userEmailPartition(user.email),
          sk: "PROFILE",
          user,
          createdAt: user.createdAt,
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );

    return user;
  }

  private userPartition(userId: string) {
    return `USER#${userId}`;
  }

  private messageSortKey(messageId: string) {
    return `MESSAGE#${messageId}`;
  }

  private userEmailPartition(email: string) {
    return `AUTH#${email.toLowerCase()}`;
  }
}

export const messageStore: MessageStore = tableName
  ? new DynamoMessageStore()
  : new MemoryMessageStore();
