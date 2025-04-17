# Daily Tools Library

A library for database operations and file storage utilities.

## Installation

```bash
npm install daily-tools-lib
```

## Database Service

The library provides database services for PostgreSQL:

```typescript
import { DatabaseService } from 'tts-hub-lib';

// Create a database service instance
const userService = new DatabaseService('users');

// Create a new record
const newUser = await userService.create({
  name: 'John Doe',
  email: 'john@example.com'
});

// Find a record by id
const user = await userService.findById(1);

// Update a record
const updatedUser = await userService.update(1, {
  name: 'John Smith'
});

// Delete a record
const deletedUser = await userService.delete(1);
```

## File Upload Service

The library provides file storage utilities:

```typescript
import { FileUploaderService } from 'tts-hub-lib';

// Create a file uploader instance
const uploader = new FileUploaderService({
  maxFileSize: 10 * 1024 * 1024, // 10MB
  allowedFileTypes: ['image/jpeg', 'image/png'],
  endpoint: 'https://your-storage-endpoint.com',
  accessKeyId: 'your-access-key',
  secretAccessKey: 'your-secret-key'
});

// Upload a file
const file = await uploader.createFileFromPath('/path/to/file.jpg');
const url = await uploader.uploadFile({
  file,
  bucketName: 'my-bucket',
  keyPrefix: 'images'
});

// Generate pre-signed URL
const uploadUrl = await uploader.getPresignedUploadUrl({
  bucketName: 'my-bucket',
  key: 'images/file.jpg'
});

// Delete files
await uploader.deleteObjects({
  bucketName: 'my-bucket',
  keys: ['images/1.jpg', 'images/2.jpg']
});
```

## Environment Variables

The library uses the following environment variables:

- `POSTGRES_CONNECTION_STRING`: PostgreSQL connection string
- `R2_ENDPOINT`: S3/R2 storage endpoint
- `R2_ACCESS_KEY_ID`: S3/R2 access key ID
- `R2_SECRET_ACCESS_KEY`: S3/R2 secret access key
- `NEXT_PUBLIC_STORAGE_DOMAIN` or `NEXT_PUBLIC_STORAGE_URL`: Base URL for file storage

## License

MIT