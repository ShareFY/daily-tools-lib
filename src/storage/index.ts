import { FileUploaderService } from './file-upload-service';

export { 
  FileUploaderService,
  // Export types
  FileUploaderConfig,
  UploadFileParams,
  UploadLocalFileParams,
  UploadBatchParams,
  PresignedUrlParams,
  DeleteObjectParams,
  DeleteObjectsParams,
  ListObjectsParams
} from './file-upload-service';

// Create a default instance
const fileUploadService = new FileUploaderService();
export default fileUploadService;