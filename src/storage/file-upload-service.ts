import { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, ListObjectsV2CommandOutput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs";
import mime from 'mime';
import path from 'path';
import { createHash } from 'crypto';

/**
 * FileUploaderService：文件上传 Cloudflare R2 工具类
 * 这个方法参数是对象格式
 */

export interface FileUploaderConfig {
    maxFileSize?: number;
    allowedFileTypes?: string[];
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    baseRemoteUrl?: string;
}

export interface UploadFileParams {
    file: File;         // 文件对象
    bucketName: string; // 存储桶名称
    keyPrefix?: string; // 存储Key前缀，不能以 "/" 开头（eg. demo/upload）
    keyName?: string;   // 上传文件名称，不要文件类型（为空使用原文件名）
    keySuffix?: string; // 存储Key后缀（eg. png、jpg等）
}

export interface UploadLocalFileParams {
    filePath: string;   // 文件全路径
    bucketName: string; // 存储桶名称
    keyPrefix?: string; // 存储Key前缀，不能以 "/" 开头（eg. demo/upload）
    keyName?: string;   // 上传文件名称，不要文件类型（为空使用原文件名）
    keySuffix?: string; // 存储Key后缀（eg. png、jpg等）
    removeAfterUpload?: boolean; // 是否删除本地文件（true-删除本地文件；false-不删除本地文件）
}

export interface UploadBatchParams {
    filePaths: string[]; // 文件全路径数组
    bucketName: string; // 存储桶名称
    keyPrefix?: string; // 存储Key前缀，不能以 "/" 开头（eg. demo/upload）
    keyName?: string;   // 上传文件名称，不要文件类型（为空使用原文件名）
    keySuffix?: string; // 存储Key后缀（eg. png、jpg等）
    removeAfterUpload?: boolean; // 是否删除本地文件（true-删除本地文件；false-不删除本地文件）
}

export interface PresignedUrlParams {
    bucketName: string; // 存储桶名称
    key: string;        // 存储Key
    expiresIn?: number; // 过期时间（秒）
}

export interface DeleteObjectParams {
    bucketName: string; // 存储桶名称
    key: string;        // 存储Key
}

export interface DeleteObjectsParams {
    bucketName: string; // 存储桶名称
    keys: string[];    // 存储Key数组
}

export interface ListObjectsParams {
    bucketName: string; // 存储桶名称
}

export class FileUploaderService {
    private s3Client: S3Client;
    private baseRemoteUrl: string;
    private maxFileSize: number = 5 * 1024 * 1024; // 5MB
    private allowedFileTypes: string[] = [];
    private fileCache: Map<string, string>;

    constructor(config?: FileUploaderConfig) {
        this.baseRemoteUrl = config?.baseRemoteUrl || 
                            process.env.NEXT_PUBLIC_STORAGE_DOMAIN || 
                            process.env.NEXT_PUBLIC_STORAGE_URL || 
                            "";
        this.fileCache = new Map();

        if (config?.maxFileSize) {
            this.maxFileSize = config.maxFileSize;
        }

        if (config?.allowedFileTypes) {
            this.allowedFileTypes = config.allowedFileTypes;
        }

        this.s3Client = new S3Client({
            region: 'auto',
            endpoint: config?.endpoint || process.env.R2_ENDPOINT,
            credentials: {
                accessKeyId: config?.accessKeyId || process.env.R2_ACCESS_KEY_ID!,
                secretAccessKey: config?.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY!
            }
        });
    }

    /**
     * Calculate file hash for caching
     */
    private async calculateFileHash(file: File): Promise<string> {
        const arrayBuffer = await file.arrayBuffer();
        const hash = createHash('sha256');
        hash.update(Buffer.from(arrayBuffer));
        return hash.digest('hex');
    }

    /**
     * Create a File object from a local file path
     */
    async createFileFromPath(filePath: string): Promise<File> {
        try {
            const buffer = await fs.promises.readFile(filePath);
            const fileName = path.basename(filePath);
            const fileType = mime.getType(filePath) || 'application/octet-stream';
            return new File([buffer], fileName, { type: fileType });
        } catch (error) {
            console.error(`Error creating File object from ${filePath}:`, error);
            throw error;
        }
    }

    /**
     * 上传 File 对象文件到 Cloudflare R2
     * @param {UploadFileParams} params 上传参数
     * @returns {Promise<string>} 返回上传后的文件URL
     */
    async uploadFile(params: UploadFileParams): Promise<string> {
        const { file, bucketName, keyPrefix = '', keyName = '', keySuffix = '' } = params;

        console.log(`Uploading file: ${file.name} to ${bucketName}, keyPrefix: ${keyPrefix}, keyName: ${keyName}, keySuffix: ${keySuffix}`);
        if (!bucketName) {
            throw new Error('bucketName cannot be empty');
        }

        // Validate file zise
        if (file.size > this.maxFileSize) {
            throw new Error('File size exceeds the limit');
        }

        // Validate file type
        if (this.allowedFileTypes.length > 0 && !this.allowedFileTypes.includes(file.type)) {
            throw new Error('Invalid file type');
        }

        // Check cache
        const fileHash = await this.calculateFileHash(file);
        if (this.fileCache.has(fileHash)) {
            return this.fileCache.get(fileHash)!;
        }

        const fileBuffer = await file.arrayBuffer();
        const mimeType = file.type || 'application/octet-stream';
        const fileExt = file.name.split('.').pop();

        const finalKeyName = keyName || file.name.split('.').slice(0, -1).join('.');
        const finalKeySuffix = keySuffix || fileExt || '';
        const finalKey = keyPrefix ? `${keyPrefix}/${finalKeyName}.${finalKeySuffix}` : `${finalKeyName}.${finalKeySuffix}`;

        const url = await this.uploadToStorage({
            bucketName,
            key: finalKey,
            data: Buffer.from(fileBuffer),
            contentType: mimeType
        });

        this.fileCache.set(fileHash, url);
        return url;
    }

    /**
     * 上传本地文件 到 Cloudflare R2
     * @param {UploadLocalFileParams} params 上传参数
     * @returns {Promise<string>} 返回上传后的文件URL
     */
    async uploadLocalFile(params: UploadLocalFileParams): Promise<string> {
        const { filePath, bucketName, keyPrefix = '', keyName = '', keySuffix = '', removeAfterUpload = false } = params;

        if (!fs.existsSync(filePath)) {
            throw new Error('File not found: ' + filePath);
        }

        const fileBuffer = fs.readFileSync(filePath);
        const mimeType = mime.getType(keySuffix || filePath) || 'application/octet-stream';
        const fileExt = path.extname(filePath).slice(1);

        const finalKeyName = keyName || path.basename(filePath, path.extname(filePath));
        const finalKeySuffix = keySuffix || fileExt;
        const finalKey = keyPrefix ? `${keyPrefix}/${finalKeyName}.${finalKeySuffix}` : `${finalKeyName}.${finalKeySuffix}`;

        const url = await this.uploadToStorage({
            bucketName,
            key: finalKey,
            data: fileBuffer,
            contentType: mimeType
        });

        if (removeAfterUpload) {
            await fs.promises.unlink(filePath).catch(err => console.error('Failed to delete file:', err));
        }

        return url;
    }

    /**
     * 上传文件流 到 Cloudflare R2
     * @param {Object} params 上传参数
     * @param {string} params.bucketName 存储桶名称
     * @param {string} params.key 存储Key
     * @param {Buffer} params.data 要上传的Buffer数据
     * @param {string} params.fileExt 文件格式后缀，比如：mp3等，默认为application/octet-stream
     * @returns {Promise<string>} 返回上传后的文件URL
     */
    async uploadFileBuffer(params: {
        bucketName: string;
        storagekey: string;
        fileBuffer: Buffer;
        fileExt: string;
    }): Promise<string> {
        const { bucketName, storagekey, fileBuffer, fileExt } = params;
        const contentType = this.getMimeType(fileExt);

        const url = await this.uploadToStorage({
            bucketName,
            key: storagekey,
            data: fileBuffer,
            contentType: contentType
        });
        return url;
    }

    /**
     * Upload multiple files in parallel using workers
     * @param {UploadBatchParams} params 批量上传参数
     * @returns {Promise<string[]>} 返回上传后的文件URL数组
     */
    async uploadBatch(params: UploadBatchParams): Promise<string[]> {
        const { filePaths, bucketName, keyPrefix = '', keyName = '', keySuffix = '', removeAfterUpload = false } = params;

        const results = await Promise.all(
            filePaths.map(filePath =>
                this.uploadLocalFile({
                    filePath,
                    bucketName,
                    keyPrefix,
                    keyName,
                    keySuffix,
                    removeAfterUpload
                })
            )
        );
        return results;
    }

    /**
     * Generate pre-signed URL for upload
     * @param {PresignedUrlParams} params 预签名URL参数
     * @returns {Promise<string>} 返回预签名URL
     */
    async getPresignedUploadUrl(params: PresignedUrlParams): Promise<string> {
        const { bucketName, key, expiresIn = 3600 } = params;
        const command = new PutObjectCommand({ Bucket: bucketName, Key: key });
        return await getSignedUrl(this.s3Client, command, { expiresIn });
    }

    /**
     * Generate pre-signed URL for download
     * @param {PresignedUrlParams} params 预签名URL参数
     * @returns {Promise<string>} 返回预签名URL
     */
    async getPresignedDownloadUrl(params: PresignedUrlParams): Promise<string> {
        const { bucketName, key, expiresIn = 3600 } = params;
        const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
        return await getSignedUrl(this.s3Client, command, { expiresIn });
    }

    /**
     * Delete a single object
     * @param {DeleteObjectParams} params 删除对象参数
     * @returns {Promise<void>}
     */
    async deleteObject(params: DeleteObjectParams): Promise<void> {
        const { bucketName, key } = params;
        await this.s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: key
        }));
    }

    /**
     * Delete multiple objects
     * @param {DeleteObjectsParams} params 批量删除对象参数
     * @returns {Promise<void>}
     */
    async deleteObjects(params: DeleteObjectsParams): Promise<void> {
        const { bucketName, keys } = params;
        await this.s3Client.send(new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: {
                Objects: keys.map(key => ({ Key: key }))
            }
        }));
    }

    /**
     * List objects in bucket
     * @param {ListObjectsParams} params 列出对象参数
     * @returns {Promise<ListObjectsV2CommandOutput>} 返回对象列表
     */
    async listObjects(params: ListObjectsParams): Promise<ListObjectsV2CommandOutput> {
        const { bucketName } = params;
        return await this.s3Client.send(new ListObjectsV2Command({
            Bucket: bucketName
        }));
    }

    /**
     * Core upload method
     * @param {Object} params 上传参数
     * @param {string} params.bucketName 存储桶名称
     * @param {string} params.key 存储Key
     * @param {Buffer} params.data 要上传的Buffer数据
     * @param {string} params.contentType 文件的MIME类型，默认为application/octet-stream
     * @returns {Promise<string>} 返回上传后的文件URL
     */
    private async uploadToStorage(params: {
        bucketName: string;
        key: string;
        data: Buffer;
        contentType: string;
    }): Promise<string> {
        const { bucketName, key, data, contentType } = params;

        const response = await this.s3Client.send(new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: data,
            ACL: 'public-read',
            ContentType: contentType || 'application/octet-stream'
        }));

        if (response['$metadata']['httpStatusCode'] === 200) {
            console.log('File uploaded successfully');
            return `${this.baseRemoteUrl}/${key}`;
        }
        console.log('File upload error:', response);
        throw new Error('Upload failed');
    }

    getMimeType(extension: string): string {
        const mimeType = mime.getType(extension);
        return mimeType || 'unknown';
    }

    /**
     * Get the current maxFileSize being used
     */
    getMaxFileSize(): number {
        return this.maxFileSize;
    }

    /**
     * Set a new maxFileSize to limit
     */
    setMaxFileSize(maxFileSize: number): void {
        this.maxFileSize = maxFileSize;
    }

    /**
     * Get the current allowedFileTypes array being used
     */
    getAllowedFileTypes(): string[] {
        return this.allowedFileTypes;
    }

    /**
     * Set a new allowedFileTypes array to limit
     */
    setAllowedFileTypes(allowedFileTypes: string[]): void {
        this.allowedFileTypes = allowedFileTypes;
    }
}

// Create a singleton instance
const fileUploadService = new FileUploaderService();
export default fileUploadService;




// const uploader = new FileUploaderService();

// // Upload a single file
// const file = await uploader.createFileFromPath('/path/to/file.jpg');
// const url = await uploader.uploadFile({
//   file,
//   bucketName: 'my-bucket',
//   keyPrefix: 'images'
// });

// // Generate pre-signed URL
// const uploadUrl = await uploader.getPresignedUploadUrl({
//   bucketName: 'my-bucket',
//   key: 'images/file.jpg'
// });

// // Batch upload
// const urls = await uploader.uploadBatch({
//   filePaths: ['/path/1.jpg', '/path/2.jpg'],
//   bucketName: 'my-bucket',
//   keyPrefix: 'images'
// });

// // Delete files
// await uploader.deleteObjects({
//   bucketName: 'my-bucket',
//   keys: ['images/1.jpg', 'images/2.jpg']
// });