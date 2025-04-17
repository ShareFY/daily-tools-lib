import { Pool, QueryResult, QueryResultRow } from 'pg';

type QueryParams = string | number | boolean | Date | null;

// Define types for the enhanced query operations
type SortOrder = 'ASC' | 'DESC';
type SortOptions = Record<string, SortOrder>;

interface PaginationOptions {
    page: number;
    limit: number;
}

type WhereOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN' | 'IS NULL' | 'IS NOT NULL';
interface WhereCondition {
    field: string;
    operator: WhereOperator;
    value: QueryParams | QueryParams[];
}
interface WhereOptions {
    conditions: WhereCondition[];
    logic: 'AND' | 'OR';
}
// 新增条件组接口
interface ConditionGroup {
    conditions: (WhereCondition | ConditionGroup)[];
    logic: 'AND' | 'OR';
}

class DatabasePool {
    private static instance: DatabasePool;
    private pool: Pool;

    private constructor(connectionString?: string) {
        this.pool = new Pool({
            connectionString: connectionString || process.env.POSTGRES_CONNECTION_STRING,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        });

        this.pool.on('connect', () => {
            console.log('Connected to the database');
        });

        this.pool.on('error', (err) => {
            console.error('Unexpected error on idle client', err);
            process.exit(-1);
        });
    }

    public static getInstance(connectionString?: string): DatabasePool {
        if (!DatabasePool.instance) {
            DatabasePool.instance = new DatabasePool(connectionString);
        }
        return DatabasePool.instance;
    }

    public getPool(): Pool {
        return this.pool;
    }

    public async close(): Promise<void> {
        await this.pool.end();
    }
}

export class DatabaseService {
    private tableName: string;
    private pool: Pool;

    constructor(tableName: string, connectionString?: string) {
        this.tableName = tableName;
        this.pool = DatabasePool.getInstance(connectionString).getPool();
    }

    // Private method to execute queries with automatic connection management
    private async query<T extends QueryResultRow>(text: string, params: QueryParams[] = []): Promise<QueryResult<T>> {
        console.log('Executing query:', text);
        console.log('Query parameters:', params);

        const client = await this.pool.connect();
        try {
            const result = await client.query<T>(text, params);
            console.log('Query result rows:', result.rowCount);
            return result;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        } finally {
            client.release();
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

    // Create multiple records in a single transaction
    async bulkCreate<T extends QueryResultRow>(dataArray: Record<string, QueryParams>[]): Promise<QueryResult<T>> {
        if (dataArray.length === 0) {
            throw new Error('No data provided for bulk create operation');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const columns = Object.keys(dataArray[0]);
            const columnStr = columns.join(', ');

            // Create a values string for all records
            let valueStr = '';
            const allValues: QueryParams[] = [];

            dataArray.forEach((data, rowIndex) => {
                const rowValues = columns.map(col => data[col]);
                const placeholders = rowValues.map((_, colIndex) =>
                    `$${rowIndex * columns.length + colIndex + 1}`
                ).join(', ');

                valueStr += `(${placeholders})${rowIndex < dataArray.length - 1 ? ', ' : ''}`;
                allValues.push(...rowValues);
            });

            const sql = `INSERT INTO ${this.tableName} (${columnStr}) VALUES ${valueStr} RETURNING *`;
            const result = await client.query<T>(sql, allValues);

            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Bulk create operation failed:', error);
            throw error;
        } finally {
            client.release();
        }
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

    // Read all records with optional conditions
    async findAllCustom<T extends QueryResultRow>(
        conditions: Record<string, QueryParams> = {},
        sortOptions?: SortOptions,
        whereOptions?: ConditionGroup
    ): Promise<QueryResult<T>> {
        let sql = `SELECT * FROM ${this.tableName}`;
        const values: QueryParams[] = [];
        let paramIndex = 1;

        // Handle nested condition groups
        if (whereOptions && whereOptions.conditions.length > 0) {
            sql += ` WHERE ${this.buildWhereClause(whereOptions, values, paramIndex)}`;
        }
        // Legacy conditions support
        else if (Object.keys(conditions).length > 0) {
            const whereClauses = Object.keys(conditions).map((key) => {
                values.push(conditions[key]);
                return `${key} = $${paramIndex++}`;
            });
            sql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        // Add sorting
        if (sortOptions && Object.keys(sortOptions).length > 0) {
            const sortClauses = Object.entries(sortOptions).map(
                ([field, order]) => `${field} ${order}`
            );
            sql += ` ORDER BY ${sortClauses.join(', ')}`;
        }

        return await this.query<T>(sql, values);
    }

    // Recursive WHERE clause builder
    private buildWhereClause(
        group: ConditionGroup,
        values: QueryParams[],
        paramIndex: number
    ): string {
        const clauses: string[] = [];

        for (const item of group.conditions) {
            if ('field' in item) {
                // This is a simple condition
                const condition = item as WhereCondition;
                if (condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL') {
                    clauses.push(`${condition.field} ${condition.operator}`);
                } else if (condition.operator === 'IN' && Array.isArray(condition.value)) {
                    const placeholders = (condition.value as QueryParams[]).map(() => {
                        values.push(condition.value as QueryParams);
                        return `$${paramIndex++}`;
                    }).join(', ');
                    clauses.push(`${condition.field} IN (${placeholders})`);
                } else {
                    values.push(condition.value as QueryParams);
                    clauses.push(`${condition.field} ${condition.operator} $${paramIndex++}`);
                }
            } else {
                // This is a nested condition group
                const nestedGroup = item as ConditionGroup;
                clauses.push(`(${this.buildWhereClause(nestedGroup, values, paramIndex)})`);
            }
        }

        return clauses.join(` ${group.logic} `);
    }

    // Find records with pagination
    async findAllWithPagination<T extends QueryResultRow>(
        paginationOptions: PaginationOptions,
        conditions: Record<string, QueryParams> = {},
        sortOptions?: SortOptions,
        whereOptions?: WhereOptions
    ): Promise<{
        data: QueryResult<T>,
        pagination: {
            page: number,
            limit: number,
            totalItems: number,
            totalPages: number
        }
    }> {
        // First, count total number of records
        let countSql = `SELECT COUNT(*) FROM ${this.tableName}`;
        const values: QueryParams[] = [];
        let paramIndex = 1;

        // Handle WHERE conditions for count
        if (whereOptions && whereOptions.conditions.length > 0) {
            const whereClauses = whereOptions.conditions.map(condition => {
                if (condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL') {
                    return `${condition.field} ${condition.operator}`;
                } else if (condition.operator === 'IN' && Array.isArray(condition.value)) {
                    const placeholders = (condition.value as QueryParams[]).map((val) => {
                        values.push(val);
                        return `$${paramIndex++}`;
                    }).join(', ');
                    return `${condition.field} IN (${placeholders})`;
                } else {
                    values.push(condition.value as QueryParams);
                    return `${condition.field} ${condition.operator} $${paramIndex++}`;
                }
            });
            countSql += ` WHERE ${whereClauses.join(` ${whereOptions.logic} `)}`;
        }
        // Legacy conditions support
        else if (Object.keys(conditions).length > 0) {
            const whereClauses = Object.keys(conditions).map((key) => {
                values.push(conditions[key]);
                return `${key} = $${paramIndex++}`;
            });
            countSql += ` WHERE ${whereClauses.join(' AND ')}`;
        }

        const countResult = await this.query(countSql, values);
        const totalItems = parseInt(countResult.rows[0].count, 10);
        const totalPages = Math.ceil(totalItems / paginationOptions.limit);

        // Now get the actual data with pagination
        const offset = (paginationOptions.page - 1) * paginationOptions.limit;

        // Reuse findAll with added LIMIT and OFFSET
        const dataSql = await this.findAllCustom<T>(conditions, sortOptions, whereOptions);
        dataSql.command += ` LIMIT ${paginationOptions.limit} OFFSET ${offset}`;

        return {
            data: dataSql,
            pagination: {
                page: paginationOptions.page,
                limit: paginationOptions.limit,
                totalItems,
                totalPages
            }
        };
    }

    // Update a record by ID
    async update<T extends QueryResultRow>(id: number | string, data: Record<string, QueryParams>): Promise<QueryResult<T>> {
        const setClauses = Object.keys(data).map((key, index) => `${key} = $${index + 1}`);
        const values = [...Object.values(data), id];

        const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`;
        return await this.query<T>(sql, values);
    }

    // Bulk update records with specified conditions
    async bulkUpdate<T extends QueryResultRow>(
        whereOptions: WhereOptions,
        data: Record<string, QueryParams>
    ): Promise<QueryResult<T>> {
        if (Object.keys(data).length === 0) {
            throw new Error('No data provided for bulk update operation');
        }

        const setClauses = Object.keys(data).map((key, index) => `${key} = $${index + 1}`);
        const values = [...Object.values(data)];
        let paramIndex = values.length + 1;

        // Build WHERE clause
        const whereClauses = whereOptions.conditions.map(condition => {
            if (condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL') {
                return `${condition.field} ${condition.operator}`;
            } else if (condition.operator === 'IN' && Array.isArray(condition.value)) {
                const placeholders = (condition.value as QueryParams[]).map((val) => {
                    values.push(val);
                    return `$${paramIndex++}`;
                }).join(', ');
                return `${condition.field} IN (${placeholders})`;
            } else {
                values.push(condition.value as QueryParams);
                return `${condition.field} ${condition.operator} $${paramIndex++}`;
            }
        });

        const sql = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(` ${whereOptions.logic} `)} RETURNING *`;
        return await this.query<T>(sql, values);
    }

    // Delete a record by ID
    async delete<T extends QueryResultRow>(id: number | string): Promise<QueryResult<T>> {
        const sql = `DELETE FROM ${this.tableName} WHERE id = $1 RETURNING *`;
        return await this.query<T>(sql, [id]);
    }

    // Bulk delete records with specified conditions
    async bulkDelete<T extends QueryResultRow>(whereOptions: WhereOptions): Promise<QueryResult<T>> {
        const values: QueryParams[] = [];
        let paramIndex = 1;

        // Build WHERE clause
        const whereClauses = whereOptions.conditions.map(condition => {
            if (condition.operator === 'IS NULL' || condition.operator === 'IS NOT NULL') {
                return `${condition.field} ${condition.operator}`;
            } else if (condition.operator === 'IN' && Array.isArray(condition.value)) {
                const placeholders = (condition.value as QueryParams[]).map((val) => {
                    values.push(val);
                    return `$${paramIndex++}`;
                }).join(', ');
                return `${condition.field} IN (${placeholders})`;
            } else {
                values.push(condition.value as QueryParams);
                return `${condition.field} ${condition.operator} $${paramIndex++}`;
            }
        });

        const sql = `DELETE FROM ${this.tableName} WHERE ${whereClauses.join(` ${whereOptions.logic} `)} RETURNING *`;
        return await this.query<T>(sql, values);
    }

    // Execute a custom query
    async executeQuery<T extends QueryResultRow>(sql: string, params: QueryParams[] = []): Promise<QueryResult<T>> {
        return await this.query<T>(sql, params);
    }

    // Static method to close the pool
    static async closePool(): Promise<void> {
        await DatabasePool.getInstance().close();
    }
}


// 使用示例：
// 定义返回类型
// interface User {
//     id: number;
//     name: string;
//     email: string;
// }
// // 创建服务实例
// const userService = new DatabaseService('users');

// // 使用服务（不需要手动管理连接）
// try {
//     // 创建用户
//     const newUser = await userService.create<User>({
//         name: 'John Doe',
//         email: 'john@example.com'
//     });

//     // 查询用户
//     const user = await userService.findById<User>(1);

//     // 更新用户
//     const updatedUser = await userService.update<{ id: number; name: string }>(1, {
//         name: 'John Smith'
//     });

// } catch (error) {
//     console.error('Database operation failed:', error);
// }


// 批量创建数据
// const usersToCreate = [
//     { name: '张三', email: 'zhangsan@example.com' },
//     { name: '李四', email: 'lisi@example.com' },
//     { name: '王五', email: 'wangwu@example.com' }
//   ];
//   const newUsers = await userService.bulkCreate<User>(usersToCreate);

//   // 使用高级条件查询
//   const users = await userService.findAll<User>(
//     {}, // 空条件对象
//     { name: 'ASC' }, // 按名称正序排序
//     {
//       conditions: [
//         { field: 'age', operator: '>=', value: 18 },
//         { field: 'status', operator: '=', value: 'active' }
//       ],
//       logic: 'AND' // 使用AND逻辑
//     }
//   );

//   // 使用分页查询
//   const paginatedUsers = await userService.findAllWithPagination<User>(
//     { page: 1, limit: 10 }, // 分页选项
//     {}, // 空条件对象
//     { created_at: 'DESC' }, // 按创建时间倒序排序
//     {
//       conditions: [
//         { field: 'department', operator: '=', value: 'IT' },
//         { field: 'is_admin', operator: '=', value: true }
//       ],
//       logic: 'OR' // 使用OR逻辑
//     }
//   );

//   // 批量更新数据
//   const updatedUsers = await userService.bulkUpdate<User>(
//     {
//       conditions: [
//         { field: 'department', operator: '=', value: 'Marketing' }
//       ],
//       logic: 'AND'
//     },
//     { status: 'inactive', updated_at: new Date() }
//   );

//   // 批量删除数据
//   const deletedUsers = await userService.bulkDelete<User>({
//     conditions: [
//       { field: 'last_login', operator: '<', value: new Date('2023-01-01') },
//       { field: 'status', operator: '=', value: 'inactive' }
//     ],
//     logic: 'AND'
//   });


// 支持任意深度的嵌套条件，可以构建非常复杂的查询。所有其他需要条件的方法（如 findAllWithPagination、bulkUpdate、bulkDelete 等）也应该相应更新，使用这个新的递归 buildWhereClause 方法。
// 复杂查询示例：
// (status = 'active' AND age >= 18) OR (department = 'IT' AND experience >= 5)
// const results = await userService.findAllCustom(
//     {}, // 空条件对象
//     { name: 'ASC' }, // 按名称排序
//     {
//         logic: 'OR',
//         conditions: [
//             // 第一组条件 (status = 'active' AND age >= 18)
//             {
//                 logic: 'AND',
//                 conditions: [
//                     { field: 'status', operator: '=', value: 'active' },
//                     { field: 'age', operator: '>=', value: 18 }
//                 ]
//             },
//             // 第二组条件 (department = 'IT' AND experience >= 5)
//             {
//                 logic: 'AND',
//                 conditions: [
//                     { field: 'department', operator: '=', value: 'IT' },
//                     { field: 'experience', operator: '>=', value: 5 }
//                 ]
//             }
//         ]
//     }
// );


// 更复杂的嵌套查询示例：
// (status = 'active' AND (role = 'admin' OR role = 'manager')) OR (department = 'IT' AND created_at > '2023-01-01')
// const complexResults = await userService.findAllCustom(
//     {},
//     { created_at: 'DESC' },
//     {
//         logic: 'OR',
//         conditions: [
//             {
//                 logic: 'AND',
//                 conditions: [
//                     { field: 'status', operator: '=', value: 'active' },
//                     {
//                         logic: 'OR',
//                         conditions: [
//                             { field: 'role', operator: '=', value: 'admin' },
//                             { field: 'role', operator: '=', value: 'manager' }
//                         ]
//                     }
//                 ]
//             },
//             {
//                 logic: 'AND',
//                 conditions: [
//                     { field: 'department', operator: '=', value: 'IT' },
//                     { field: 'created_at', operator: '>', value: new Date('2023-01-01') }
//                 ]
//             }
//         ]
//     }
// );