import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useUpdatePost } from '../lib/api-cache';
import { postsApi, type BlogPost } from '../lib/api-client';
import { useAppBridgeToast } from '../hooks/useAppBridge';
import { formatAPIErrorMessage } from '../utils/error-messages';

interface ExtendedBlogPost extends BlogPost {
  readonly excerpt?: string;
  readonly seo_title?: string;
  readonly seo_description?: string;
  readonly keywords?: readonly string[];
}

interface ArticleEditorProps {
  readonly post: BlogPost;
  readonly onSave?: (post: BlogPost) => void;
  readonly onCancel?: () => void;
  readonly autoSaveInterval?: number;
}

interface PostUpdateData {
  readonly title: string;
  readonly content: string;
  readonly excerpt?: string;
  readonly seo_title?: string;
  readonly seo_description?: string;
  readonly keywords?: readonly string[];
}

const DEFAULT_AUTO_SAVE_INTERVAL = 30000;
const SEO_TITLE_MAX_LENGTH = 60;
const SEO_DESCRIPTION_MAX_LENGTH = 160;

export default function ArticleEditor({
  post,
  onSave,
  onCancel,
  autoSaveInterval = DEFAULT_AUTO_SAVE_INTERVAL,
}: ArticleEditorProps): JSX.Element {
  const extendedPost = post as ExtendedBlogPost;
  const [title, setTitle] = useState(extendedPost.title);
  const [content, setContent] = useState(extendedPost.content || '');
  const [excerpt, setExcerpt] = useState(extendedPost.excerpt || '');
  const [seoTitle, setSeoTitle] = useState(extendedPost.seo_title || '');
  const [seoDescription, setSeoDescription] = useState(extendedPost.seo_description || '');
  const [keywords, setKeywords] = useState<readonly string[]>(extendedPost.keywords || []);
  const [keywordInput, setKeywordInput] = useState('');
  const [showPreview, setShowPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const updatePostMutation = useUpdatePost();
  const autoSaveTimerRef = useRef<number | null>(null);
  const lastSaveRef = useRef<string>('');
  const isMountedRef = useRef(true);
  const { showToast } = useAppBridgeToast();

  const currentState = useMemo<PostUpdateData>(
    () => ({
      title,
      content,
      excerpt: excerpt || undefined,
      seo_title: seoTitle || undefined,
      seo_description: seoDescription || undefined,
      keywords: keywords.length > 0 ? keywords : undefined,
    }),
    [title, content, excerpt, seoTitle, seoDescription, keywords],
  );

  const currentStateString = useMemo(
    () => JSON.stringify(currentState),
    [currentState],
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (autoSaveTimerRef.current !== null) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setHasUnsavedChanges(currentStateString !== lastSaveRef.current);
  }, [currentStateString]);

  const saveDraft = useCallback(async (): Promise<void> => {
    if (isSaving || !isMountedRef.current) {
      return;
    }

    if (currentStateString === lastSaveRef.current) {
      return;
    }

    setIsSaving(true);
    try {
      await updatePostMutation.mutateAsync({
        postId: post.id,
        updates: {
          title: currentState.title,
          content: currentState.content,
          ...(currentState.excerpt && { excerpt: currentState.excerpt }),
          ...(currentState.seo_title && { seo_title: currentState.seo_title }),
          ...(currentState.seo_description && {
            seo_description: currentState.seo_description,
          }),
          ...(currentState.keywords && { keywords: currentState.keywords }),
        } as Partial<BlogPost>,
      });
      lastSaveRef.current = currentStateString;
      setLastSaved(new Date());
      setHasUnsavedChanges(false);
    } catch (error) {
      if (isMountedRef.current) {
        const errorMessage = formatAPIErrorMessage(error, {
          action: 'save draft',
          resource: 'article',
        });
        showToast(errorMessage, { isError: true });
      }
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  }, [currentStateString, currentState, post.id, updatePostMutation, isSaving, showToast]);

  useEffect(() => {
    if (!hasUnsavedChanges || !isMountedRef.current) {
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      if (isMountedRef.current) {
        saveDraft().catch(() => {
        });
      }
    }, autoSaveInterval);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [hasUnsavedChanges, autoSaveInterval, saveDraft]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current) {
      return;
    }

    try {
      await saveDraft();
      if (onSave) {
        const updatedPost = await postsApi.get(post.id);
        if (isMountedRef.current) {
          onSave(updatedPost);
        }
      }
      if (isMountedRef.current) {
        showToast('Article saved successfully', { isError: false });
      }
    } catch (error) {
      if (isMountedRef.current) {
        const errorMessage = formatAPIErrorMessage(error, {
          action: 'save article',
          resource: 'article',
        });
        showToast(errorMessage, { isError: true });
      }
    }
  }, [saveDraft, onSave, post.id, showToast]);

  const handleAddKeyword = useCallback((): void => {
    const trimmedKeyword = keywordInput.trim();
    if (trimmedKeyword && !keywords.includes(trimmedKeyword)) {
      setKeywords([...keywords, trimmedKeyword]);
      setKeywordInput('');
    }
  }, [keywordInput, keywords]);

  const handleRemoveKeyword = useCallback(
    (keyword: string): void => {
      setKeywords(keywords.filter((k) => k !== keyword));
    },
    [keywords],
  );

  const handleKeywordKeyPress = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddKeyword();
      }
    },
    [handleAddKeyword],
  );

  const togglePreview = useCallback((): void => {
    setShowPreview((prev) => !prev);
  }, []);

  const handleCancel = useCallback((): void => {
    if (onCancel) {
      onCancel();
    }
  }, [onCancel]);

  const sanitizedContent = useMemo(() => {
    if (!content) {
      return '<p>No content yet.</p>';
    }
    return content;
  }, [content]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 lg:px-8 py-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900 truncate">
              Edit Article
            </h1>
            <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
              {isSaving && (
                <span className="text-xs sm:text-sm text-gray-500 flex items-center gap-2 whitespace-nowrap">
                  <svg
                    className="animate-spin h-4 w-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Saving...
                </span>
              )}
              {lastSaved && !isSaving && (
                <span className="text-xs sm:text-sm text-gray-500 whitespace-nowrap">
                  Saved {lastSaved.toLocaleTimeString()}
                </span>
              )}
              {hasUnsavedChanges && !isSaving && (
                <span className="text-xs sm:text-sm text-orange-600 whitespace-nowrap">
                  Unsaved changes
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={togglePreview}
              type="button"
              className="px-3 py-1.5 text-xs sm:text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors touch-manipulation whitespace-nowrap"
            >
              {showPreview ? 'Edit' : 'Preview'}
            </button>
            {onCancel && (
              <button
                onClick={handleCancel}
                type="button"
                className="px-3 py-1.5 text-xs sm:text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors touch-manipulation whitespace-nowrap"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              type="button"
              disabled={isSaving || !hasUnsavedChanges}
              className="px-3 sm:px-4 py-1.5 text-xs sm:text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation whitespace-nowrap"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex">
        {showPreview ? (
          <div className="flex-1 overflow-y-auto p-6 bg-white">
            <div className="prose max-w-none">
              <h1 className="text-3xl font-bold mb-4">{title || 'Untitled'}</h1>
              {excerpt && <p className="text-lg text-gray-600 mb-6">{excerpt}</p>}
              <div
                className="article-content"
                dangerouslySetInnerHTML={{ __html: sanitizedContent }}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
            <div className="max-w-4xl mx-auto space-y-6">
              <div>
                <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-2">
                  Title *
                </label>
                <input
                  id="title"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                  placeholder="Enter article title..."
                  maxLength={500}
                />
              </div>

              <div>
                <label
                  htmlFor="excerpt"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Excerpt
                </label>
                <textarea
                  id="excerpt"
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                  placeholder="Brief description of the article..."
                  maxLength={500}
                />
              </div>

              <div>
                <label
                  htmlFor="content"
                  className="block text-sm font-medium text-gray-700 mb-2"
                >
                  Content *
                </label>
                <textarea
                  id="content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={20}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                  placeholder="Write your article content here (HTML supported)..."
                />
              </div>

              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">SEO Settings</h3>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="seo-title"
                      className="block text-sm font-medium text-gray-700 mb-2"
                    >
                      SEO Title
                    </label>
                    <input
                      id="seo-title"
                      type="text"
                      value={seoTitle}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value.length <= SEO_TITLE_MAX_LENGTH) {
                          setSeoTitle(value);
                        }
                      }}
                      maxLength={SEO_TITLE_MAX_LENGTH}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                      placeholder="SEO optimized title (max 60 characters)"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {seoTitle.length}/{SEO_TITLE_MAX_LENGTH}
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="seo-description"
                      className="block text-sm font-medium text-gray-700 mb-2"
                    >
                      SEO Description
                    </label>
                    <textarea
                      id="seo-description"
                      value={seoDescription}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value.length <= SEO_DESCRIPTION_MAX_LENGTH) {
                          setSeoDescription(value);
                        }
                      }}
                      maxLength={SEO_DESCRIPTION_MAX_LENGTH}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                      placeholder="SEO meta description (max 160 characters)"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {seoDescription.length}/{SEO_DESCRIPTION_MAX_LENGTH}
                    </p>
                  </div>
                  <div>
                    <label
                      htmlFor="keywords"
                      className="block text-sm font-medium text-gray-700 mb-2"
                    >
                      Keywords
                    </label>
                    <div className="flex gap-2 mb-2">
                      <input
                        id="keywords"
                        type="text"
                        value={keywordInput}
                        onChange={(e) => setKeywordInput(e.target.value)}
                        onKeyPress={handleKeywordKeyPress}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none"
                        placeholder="Add keyword and press Enter"
                        maxLength={50}
                      />
                      <button
                        onClick={handleAddKeyword}
                        type="button"
                        className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                      >
                        Add
                      </button>
                    </div>
                    {keywords.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {keywords.map((keyword) => (
                          <span
                            key={keyword}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 text-purple-800 rounded-full text-sm"
                          >
                            {keyword}
                            <button
                              onClick={() => handleRemoveKeyword(keyword)}
                              type="button"
                              className="text-purple-600 hover:text-purple-800"
                              aria-label={`Remove ${keyword}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
