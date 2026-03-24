# Cloudinary Profile Image Upload Setup

This document explains how to configure Cloudinary for profile image uploads in NutriScan.

## Overview

Profile images are now uploaded to **Cloudinary** instead of Supabase storage. This provides:
- Faster image delivery via CDN
- Automatic image optimization (quality, format, resizing)
- Unsigned uploads (no backend authentication needed)
- Secure URLs with transformations

## Setup Steps

### 1. Create Cloudinary Account
- Sign up at https://cloudinary.com
- Create a free account or use existing one
- Note your **Cloud Name** from the Dashboard

### 2. Create Upload Preset (Unsigned)

1. Go to **Settings → Upload** in Cloudinary Dashboard
2. Scroll to **Upload presets**
3. Click **Create upload preset**
4. Configure:
   - **Name**: `nutriscan_profiles`
   - **Signing Mode**: ⚠️ **UNSIGNED** (required for client-side uploads)
   - **Folder**: `nutriscan/profiles` (auto-organizes uploads)
   - **Image optimizations**:
     - Format: Auto (jpg, webp, png)
     - Quality: Auto (80-90)
   - **Save**

### 3. Environment Configuration

Add to your `.env` file:

```env
# Cloudinary Configuration
VITE_CLOUDINARY_CLOUD_NAME=your_cloud_name_here
VITE_CLOUDINARY_UPLOAD_PRESET=nutriscan_profiles
```

**Example:**
```env
VITE_CLOUDINARY_CLOUD_NAME=dzq9fyu5x
VITE_CLOUDINARY_UPLOAD_PRESET=nutriscan_profiles
```

### 4. Verify Configuration

After setting environment variables, rebuild the app:

```bash
npm run build
```

If Cloudinary config is missing, the app will throw a clear error message during profile image upload.

## Implementation Details

### Upload Function

Located in [src/App.jsx](src/App.jsx#L102):

```javascript
const uploadProfileImageToCloudinary = async(blob, filename) => {
  // - FormData with blob file
  // - Upload preset (unsigned)
  // - Auto folder organization
  // - Auto quality/format optimization
  // - Returns secure_url from Cloudinary response
}
```

### Flow

1. **User selects/captures image** → `changeProfilePicture()`
2. **Image converted to blob** → standard image format handling
3. **Upload to Cloudinary** → returns secure HTTPS URL
4. **Save URL to Supabase** → stored in `profiles.profile_image_url`
5. **Display in UI** → instant update with loading indicator

### Error Handling

- ❌ No Cloudinary config → "Cloudinary not configured" error
- ❌ Upload fails → Error message shown in toast
- ❌ No image selected → Toast notification
- ❌ Cooldown active → Can't change for 14 days after last update

### UI Behavior

- Loading indicator shows during upload
- Toast notifications for success/error
- Profile image updates instantly after upload
- 14-day cooldown prevents frequent changes

## Image Delivery

- **URL Format**: `https://res.cloudinary.com/{cloud_name}/...`
- **Auto Optimization**: Browser/device gets perfect format/quality
- **Responsive**: Fast images via CDN
- **Transforms Available**: Resize, crop, filter actions if needed

## Troubleshooting

### "Cloudinary not configured"
→ Check `.env` has `VITE_CLOUDINARY_CLOUD_NAME` and variables are loaded

### Upload fails with 401/403
→ Verify upload preset is set to **UNSIGNED** mode

### Blank profile image
→ Check browser console for network errors
→ Verify Cloudinary URL is accessible (not blocked by CORS)

### Slow uploads
→ Consider client-side image optimization before upload
→ Cloudinary handles format/quality auto-selection

## Benefits vs Supabase Storage

| Feature | Supabase Storage | Cloudinary |
|---------|-----------------|-----------|
| CDN delivery | Limited | Global ✓ |
| Image optimization | Manual | Auto ✓ |
| Format conversion | Not built-in | Auto webp/jpg ✓ |
| URL expiration | Can expire | Permanent secure URLs ✓ |
| Free tier | 1 GB | 5 GB ✓ |
| Unsigned uploads | No | Yes ✓ |

## File References

- **Upload function**: [src/App.jsx#L102-L122](src/App.jsx#L102-L122)
- **Profile upload handler**: [src/App.jsx#L2982-L2996](src/App.jsx#L2982-L2996)
- **Gallery handler**: [src/App.jsx#L3003-L3023](src/App.jsx#L3003-L3023)
- **UI display**: Dashboard and Settings show profile image from `profile_image_url`

## Notes

- Old Supabase storage reference removed from code
- Storage bucket RLS policies no longer used for profile images
- Profile image cache: Browser cache handles optimization
- Cloudinary free tier supports unlimited uploads (5 GB/month)
