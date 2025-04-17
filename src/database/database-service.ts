import { Pool, QueryResult, QueryResultRow } from 'pg';

type QueryParams = string | number | boolean | Date | null;

export class DatabaseService {
    private tableName: string;
    private pool: Pool;

    constructor(tableName: string, connectionString?: string) {
        this.tableName = tableName;
        this.pool = new Pool({
            connectionString: connectionString || process.env.POSTGRES_CONNECTION_STRING,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        });

        // Set up event listeners
        this.pool.on('connect', () => {
            console.log('Connected to the database');
        });

        this.pool.on('error', (err: Error) => {
            console.error('Unexpected error on idle client', err);
            process.exit(-1);
        });
    }

    // Private method to execute queries
    private async query<T extends QueryResultRow>(text: string, params: QueryParams[] = []): Promise<QueryResult<T>> {
        console.log('Executing query:', text);
        console.log('Query parameters:', params);
        try {
            const result = await this.pool.query<T>(text, params);
            console.log('Query result rows:', result.rowCount);
            return result;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    // Create a new record
    async create<T extends QueryResultRow>(data: Record<string, QueryParams>): Promise<QueryResult<T>> {
        const columns = Object.keys(data).join(', ');
        const values = Object.values(data);
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');

        const sql = `INSERT INTO ${this.tableName} (${columns}) VALUES (${placeholders}) RETURNING *`;
        return await this.query<T>(sql, values);
    }

    // Read a single record by ID
    async findById<T extends QueryResultRow>(id: number | string): Promise<QueryResult<T>> {
        const sql = `SELECT * FROM ${this.tableName} WHERE id = $1`;
        return await this.query<T>(sql, [id]);
    }

    // Read all records with optional conditions
    async findAll<T extends QueryResultRow>(conditions: Record<string, QueryParams> = {}): Promise<QueryResult<T>> {
        let sql = `SELECT * FROM ${this.tableName}`;
        const values: QueryParams[] = [];

        if (Object.keys(conditions).length > 0) {
            const whereClauses = Object.keys(conditions).map((key, index) => {
                values.push(conditions[key]);
                return `${key} = $${index + 1}`;
            });
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        return await this.query<T>(sql, values);
    }

    // Update a record by ID
    async update<T extends QueryResultRow>(id: number | string, data: Record<string, QueryParams>): Promise<QueryResult<T>> {
        const setClauses = Object.keys(data).map((key, index) => `${key} = $${index + 1}`);
        const values = [...Object.values(data), id];

        const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`;
        return await this.query<T>(sql, values);
    }

    // Delete a record by ID
    async delete<T extends QueryResultRow>(id: number | string): Promise<QueryResult<T>> {
        const sql = `DELETE FROM ${this.tableName} WHERE id = $1 RETURNING *`;
        return await this.query<T>(sql, [id]);
    }

    // Execute a custom query
    async executeQuery<T extends QueryResultRow>(sql: string, params: QueryParams[] = []): Promise<QueryResult<T>> {
        return await this.query<T>(sql, params);
    }

    // Close the database connection
    async close(): Promise<void> {
        await this.pool.end();
    }
}


/**
 * 使用示例
 */
// const userService = new DatabaseService('users');
// try {
//     // Create a new record:
//     const newUser = await userService.create({
//         name: 'John Doe',
//         email: 'john@example.com',
//         age: 30
//     });
//     // Find a record by ID:
//     const user = await userService.findById(1);

//     // Find all records (with optional conditions):
//     // Find all users
//     const allUsers = await userService.findAll();

//     // Find users with specific conditions
//     const activeUsers = await userService.findAll({
//         is_active: true,
//         age: 25
//     });

//     // Update a record:
//     const updatedUser = await userService.update(1, {
//         name: 'John Smith',
//         age: 31
//     });

//     // Delete a record:
//     const deletedUser = await userService.delete(1);

//     // Execute custom queries:
//     const result = await userService.executeQuery(
//         'SELECT * FROM users WHERE age > $1 AND is_active = $2',
//         [25, true]
//     );
// } catch (error) {
//     console.log(error);
// } finally {
//     // Always close the connection when done
//     await userService.close();
// }

// database-service-single-instance.ts 和  database-service.ts 的区别：
// 1、连接池管理方式不同：
// database-service.ts：每个 DatabaseService 实例都会创建一个新的连接池
// database-service-single-instance.ts：单例模式，整个应用共享同一个连接池实例
// 2、资源利用效率：
// database-service.ts：如果创建多个 DatabaseService 实例，会导致创建多个连接池，浪费系统资源
// database-service-single-instance.ts：无论创建多少个 DatabaseService 实例，都只使用一个连接池，更高效地利用系统资源
// 3、连接管理方式：
// database-service.ts：需要手动调用 close() 方法来关闭连接池
// database-service-single-instance.ts：使用 pool.connect() 和 client.release() 自动管理连接，更安全可靠
// 4、使用示例对比
// // database-service.ts 每个实例都会创建新的连接池
// const userService = new DatabaseService('users');
// const orderService = new DatabaseService('orders');
// try {
//   // 使用服务
//   const user = await userService.findById(1);
//   const order = await orderService.findById(1);
// } finally {
//   // 需要手动关闭连接
//   await userService.close();
//   await orderService.close();
// }
// // // database-service-single-instance.ts 单例模式
// // 所有实例共享同一个连接池
// const userService = new DatabaseService('users');
// const orderService = new DatabaseService('orders');

// // 不需要手动管理连接，每个查询都会自动获取和释放连接
// const user = await userService.findById(1);
// const order = await orderService.findById(1);

// 5、优势对比：
//     database-service-single-instance.ts单例模式：
//         更高效的资源利用
//         自动连接管理，避免连接泄漏
//         更好的并发处理能力
//         更简单的使用方式
//     database-service.ts：
//         每个服务实例独立，更灵活
//         可以单独控制每个连接池的生命周期
// 6、适用场景：
//     database-service-single-instance.ts单例模式：适合大多数应用场景，特别是 Web 应用
//     database-service.ts：适合需要独立控制连接池的特殊场景
// 总的来说，单例模式提供了更好的资源管理和更简单的使用方式，是更推荐的做法。除非有特殊需求，否则建议使用单例模式来管理数据库连接池。