import OpenAI from 'openai';
import { ToneMatrix, BrandDNA } from './BrandManager.ts';
import { retry } from '../utils/error-handling.ts';

export interface BlogPostContent {
  readonly title: string;
  readonly content: string;
  readonly excerpt: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
  readonly keywords: readonly string[];
  readonly primaryKeyword: string;
  readonly imagePrompt?: string;
  readonly citations?: ReadonlyArray<Citation>;
  readonly qualityScore?: number;
  readonly qualityIssues?: ReadonlyArray<QualityIssue>;
}

export interface Citation {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly url?: string;
  readonly type: 'fact' | 'statistic' | 'quote' | 'reference';
}

export interface QualityIssue {
  readonly type: 'readability' | 'keyword' | 'structure' | 'length' | 'completeness';
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly suggestion?: string;
}

export interface ContentOptions {
  readonly structure?: 'default' | 'how-to' | 'listicle' | 'comparison' | 'tutorial' | 'case-study';
  readonly language?: string;
  readonly experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
  readonly audiencePersona?: string;
  readonly includeCitations?: boolean;
  readonly validateQuality?: boolean;
  readonly contentPreferences?: {
    readonly topic_preferences?: readonly string[];
    readonly keyword_focus?: readonly string[];
    readonly content_angles?: readonly string[];
  };
}

interface OpenAIResponse {
  readonly output_text?: string;
}

interface CitationResponse {
  readonly citations?: ReadonlyArray<{
    readonly text?: string;
    readonly source?: string;
    readonly url?: string;
    readonly type?: string;
  }>;
}

interface OutlineResponse {
  readonly outline?: readonly string[];
  readonly sections?: readonly string[];
}

interface ValidationResult {
  readonly score: number;
  readonly issues: ReadonlyArray<QualityIssue>;
}

interface StructureTemplate {
  readonly [key: string]: readonly string[];
}

interface LanguageMap {
  readonly [key: string]: string;
}

interface PromptConfig {
  readonly model: string;
  readonly reasoning: { readonly effort: 'none' | 'low' | 'medium' | 'high' };
  readonly text: { readonly verbosity: 'low' | 'medium' | 'high' };
  readonly maxOutputTokens?: number;
  readonly responseFormat?: { readonly type: 'json_object' };
  readonly promptCacheKey: string;
  readonly promptCacheRetention: string;
}

export class BlogComposer {
  private readonly openai: OpenAI;
  private readonly toneMatrix: ToneMatrix;
  private readonly brandDNA: BrandDNA;
  private static readonly DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    retryableErrors: ['rate limit', 'timeout', 'server_error'] as const,
  };
  private static readonly MIN_WORD_COUNT = 1200;
  private static readonly MAX_WORD_COUNT = 1800;
  private static readonly MIN_EXCERPT_LENGTH = 50;
  private static readonly MAX_EXCERPT_LENGTH = 160;
  private static readonly MIN_SEO_TITLE_LENGTH = 60;
  private static readonly MIN_SEO_DESC_LENGTH = 160;
  private static readonly MIN_IMAGE_PROMPT_LENGTH = 20;
  private static readonly CONTENT_PREVIEW_LENGTH = 800;
  private static readonly CONTENT_SUMMARY_LENGTH = 1000;
  private static readonly CITATION_CONTENT_LENGTH = 2000;

  private static readonly STRUCTURE_TEMPLATES: StructureTemplate = {
    'how-to': [
      'Introduction: What You\'ll Learn',
      'Prerequisites and Requirements',
      'Step-by-Step Instructions',
      'Common Mistakes to Avoid',
      'Tips for Success',
      'Conclusion and Next Steps',
    ],
    'listicle': [
      'Introduction',
      'Item 1: [Topic]',
      'Item 2: [Topic]',
      'Item 3: [Topic]',
      'Item 4: [Topic]',
      'Item 5: [Topic]',
      'Conclusion: Key Takeaways',
    ],
    'comparison': [
      'Introduction',
      'Overview of Options',
      'Feature Comparison',
      'Pros and Cons',
      'Use Cases',
      'Recommendation',
      'Conclusion',
    ],
    'tutorial': [
      'Introduction',
      'What You\'ll Need',
      'Step 1: [Action]',
      'Step 2: [Action]',
      'Step 3: [Action]',
      'Troubleshooting',
      'Conclusion',
    ],
    'case-study': [
      'Introduction',
      'Background and Context',
      'The Challenge',
      'The Solution',
      'Results and Outcomes',
      'Key Takeaways',
      'Conclusion',
    ],
  };

  private static readonly DEFAULT_OUTLINE: readonly string[] = [
    'Introduction',
    'Understanding the Topic',
    'Key Benefits',
    'Best Practices',
    'Common Mistakes to Avoid',
    'Conclusion',
  ];

  private static readonly LANGUAGE_NAMES: LanguageMap = {
    en: 'English',
    fr: 'French',
    de: 'German',
    es: 'Spanish',
    nl: 'Dutch',
    it: 'Italian',
    pt: 'Portuguese',
    ru: 'Russian',
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
  };

  constructor(apiKey: string, toneMatrix: ToneMatrix, brandDNA: BrandDNA) {
    this.openai = new OpenAI({ apiKey });
    this.toneMatrix = toneMatrix;
    this.brandDNA = brandDNA;
  }

  async composePost(
    topic: string,
    keywords: readonly string[] = [],
    options: ContentOptions = {},
  ): Promise<BlogPostContent> {
    const {
      structure = 'default',
      language = 'en',
      experienceLevel,
      audiencePersona,
      includeCitations = true,
      validateQuality = true,
      contentPreferences,
    } = options;

    const outline = await this.generateOutline(topic, keywords, structure, contentPreferences);
    const title = await this.generateTitle(topic, outline, keywords, language, experienceLevel);
    const content = await this.generateContent(
      topic,
      outline,
      keywords,
      language,
      experienceLevel,
      audiencePersona,
      contentPreferences,
    );
    const excerpt = await this.generateExcerpt(content, title, language);
    const seoTitle = await this.generateSEOTitle(title, keywords, language);
    const seoDescription = await this.generateSEODescription(content, keywords, language);
    const imagePrompt = await this.generateImagePrompt(title, content, keywords);

    const citations = includeCitations
      ? await this.generateCitations(content, topic)
      : undefined;

    let qualityScore: number | undefined;
    let qualityIssues: ReadonlyArray<QualityIssue> | undefined;
    if (validateQuality) {
      const validation = await this.validateContent({
        content,
        title,
        keywords,
        outline,
      });
      qualityScore = validation.score;
      qualityIssues = validation.issues;
    }

    return {
      title,
      content,
      excerpt,
      seoTitle,
      seoDescription,
      keywords,
      primaryKeyword: keywords[0] || topic,
      imagePrompt,
      citations,
      qualityScore,
      qualityIssues,
    };
  }

  private async generateOutline(
    topic: string,
    keywords: readonly string[],
    structure: string = 'default',
    contentPreferences?: ContentOptions['contentPreferences'],
  ): Promise<readonly string[]> {
    const template = this.getStructureTemplate(structure);
    const staticPrefix = this.buildOutlineStaticPrefix(template);
    const variableContent = this.buildOutlineVariableContent(topic, keywords, contentPreferences);
    const prompt = staticPrefix + variableContent;

    const response = await this.callOpenAI({
      model: 'gpt-5-mini',
      reasoning: { effort: 'low' },
      text: { verbosity: 'medium' },
      responseFormat: { type: 'json_object' },
      promptCacheKey: `blog-outline-${this.brandDNA?.brandName || 'default'}-${structure}`,
      promptCacheRetention: '24h',
    }, prompt);

    try {
      const result = JSON.parse(response.output_text || '{}') as OutlineResponse;
      return result.outline || result.sections || template || BlogComposer.DEFAULT_OUTLINE;
    } catch {
      return template || BlogComposer.DEFAULT_OUTLINE;
    }
  }

  private async generateTitle(
    topic: string,
    outline: readonly string[],
    keywords: readonly string[],
    language: string = 'en',
    experienceLevel?: string,
  ): Promise<string> {
    const languageName = this.getLanguageName(language);
    const staticPrefix = this.buildTitleStaticPrefix(language, languageName, experienceLevel);
    const variableContent = this.buildTitleVariableContent(topic, outline, keywords);
    const prompt = staticPrefix + variableContent;

    const response = await this.callOpenAI({
      model: 'gpt-5-nano',
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      maxOutputTokens: 100,
      promptCacheKey: `blog-title-generator-${language}`,
      promptCacheRetention: '24h',
    }, prompt);

    return response.output_text?.trim() || `Complete Guide to ${topic}`;
  }

  private async generateContent(
    topic: string,
    outline: readonly string[],
    keywords: readonly string[],
    language: string = 'en',
    experienceLevel?: string,
    audiencePersona?: string,
    contentPreferences?: ContentOptions['contentPreferences'],
  ): Promise<string> {
    const tonePrompt = this.generateTonePrompt();
    const languageName = this.getLanguageName(language);
    const staticPrefix = this.buildContentStaticPrefix(
      language,
      languageName,
      tonePrompt,
      experienceLevel,
      audiencePersona,
      contentPreferences,
    );
    const variableContent = this.buildContentVariableContent(topic, outline, keywords, contentPreferences);
    const prompt = staticPrefix + variableContent;

    const response = await this.callOpenAI({
      model: 'gpt-5.1',
      reasoning: { effort: 'medium' },
      text: { verbosity: 'high' },
      maxOutputTokens: 4000,
      promptCacheKey: `blog-content-${this.brandDNA?.brandName || 'default'}-${language}`,
      promptCacheRetention: '24h',
    }, prompt);

    return response.output_text || '';
  }

  private async generateExcerpt(
    content: string,
    title: string,
    language: string = 'en',
  ): Promise<string> {
    const languageName = this.getLanguageName(language);
    const staticPrefix = this.buildExcerptStaticPrefix(language, languageName);
    const variableContent = this.buildExcerptVariableContent(title, content);
    const prompt = staticPrefix + variableContent;

    const response = await this.callOpenAI({
      model: 'gpt-5-nano',
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      maxOutputTokens: 100,
      promptCacheKey: `blog-excerpt-generator-${language}`,
      promptCacheRetention: '24h',
    }, prompt);

    const excerpt = response.output_text?.trim() || '';
    if (!excerpt || excerpt.length < BlogComposer.MIN_EXCERPT_LENGTH) {
      return this.createFallbackExcerpt(content);
    }

    return excerpt.substring(0, BlogComposer.MAX_EXCERPT_LENGTH);
  }

  private async generateSEOTitle(title: string, keywords: readonly string[], language: string = 'en'): Promise<string> {
    let seoTitle = title;
    if (keywords.length > 0 && !title.toLowerCase().includes(keywords[0].toLowerCase())) {
      seoTitle = `${keywords[0]}: ${title}`;
    }
    return seoTitle.substring(0, BlogComposer.MIN_SEO_TITLE_LENGTH);
  }

  private async generateSEODescription(
    content: string,
    keywords: readonly string[],
    language: string = 'en',
  ): Promise<string> {
    const languageName = this.getLanguageName(language);
    const staticPrefix = this.buildSEODescriptionStaticPrefix(language, languageName);
    const variableContent = this.buildSEODescriptionVariableContent(content, keywords);
    const prompt = staticPrefix + variableContent;

    const response = await this.callOpenAI({
      model: 'gpt-5-mini',
      reasoning: { effort: 'none' },
      text: { verbosity: 'low' },
      maxOutputTokens: 100,
      promptCacheKey: `seo-description-generator-${language}`,
      promptCacheRetention: '24h',
    }, prompt);

    const description = response.output_text?.trim() || '';
    return description.substring(0, BlogComposer.MIN_SEO_DESC_LENGTH);
  }

  private async generateCitations(content: string, topic: string): Promise<ReadonlyArray<Citation>> {
    const staticPrefix = this.buildCitationStaticPrefix();
    const variableContent = this.buildCitationVariableContent(content, topic);
    const prompt = staticPrefix + variableContent;

    try {
      const response = await this.callOpenAI({
        model: 'gpt-5-mini',
        reasoning: { effort: 'low' },
        text: { verbosity: 'medium' },
        responseFormat: { type: 'json_object' },
        promptCacheKey: 'citation-generator',
        promptCacheRetention: '24h',
      }, prompt);

      const result = JSON.parse(response.output_text || '{}') as CitationResponse;
      const citations = result.citations || [];

      return citations.map((citation, index) => ({
        id: `citation-${index + 1}`,
        text: citation.text || '',
        source: citation.source || 'Source',
        url: citation.url,
        type: (citation.type || 'fact') as Citation['type'],
      }));
    } catch {
      return [];
    }
  }

  private async validateContent(data: {
    readonly content: string;
    readonly title: string;
    readonly keywords: readonly string[];
    readonly outline: readonly string[];
  }): Promise<ValidationResult> {
    const issues: QualityIssue[] = [];
    let score = 100;

    const readability = this.calculateReadability(data.content);
    if (readability < 60) {
      issues.push({
        type: 'readability',
        severity: 'warning',
        message: `Readability score is ${readability.toFixed(1)}. Content may be too complex for general audience.`,
        suggestion: 'Consider simplifying sentence structure and using shorter words.',
      });
      score -= 10;
    } else if (readability > 80) {
      issues.push({
        type: 'readability',
        severity: 'info',
        message: `Readability score is ${readability.toFixed(1)}. Content is very accessible.`,
      });
    }

    if (data.keywords.length > 0) {
      const keywordDensity = this.calculateKeywordDensity(data.content, data.keywords[0]);
      if (keywordDensity < 0.5) {
        issues.push({
          type: 'keyword',
          severity: 'warning',
          message: `Keyword density (${(keywordDensity * 100).toFixed(2)}%) is below optimal range (0.5-2.0%).`,
          suggestion: `Naturally incorporate "${data.keywords[0]}" more throughout the content.`,
        });
        score -= 5;
      } else if (keywordDensity > 2.0) {
        issues.push({
          type: 'keyword',
          severity: 'warning',
          message: `Keyword density (${(keywordDensity * 100).toFixed(2)}%) exceeds optimal range (0.5-2.0%).`,
          suggestion: 'Reduce keyword usage to avoid keyword stuffing.',
        });
        score -= 5;
      }
    }

    const headingCount = (data.content.match(/^#+\s/gm) || []).length;
    if (headingCount < 3) {
      issues.push({
        type: 'structure',
        severity: 'warning',
        message: `Only ${headingCount} heading(s) found. More headings improve SEO and readability.`,
        suggestion: 'Add more subheadings to break up content and improve structure.',
      });
      score -= 5;
    } else if (headingCount > 15) {
      issues.push({
        type: 'structure',
        severity: 'info',
        message: `Many headings (${headingCount}) found. Consider consolidating some sections.`,
      });
    }

    const wordCount = data.content.split(/\s+/).length;
    if (wordCount < BlogComposer.MIN_WORD_COUNT) {
      issues.push({
        type: 'length',
        severity: 'warning',
        message: `Content is ${wordCount} words, below target range (${BlogComposer.MIN_WORD_COUNT}-${BlogComposer.MAX_WORD_COUNT} words).`,
        suggestion: 'Expand content with more examples, details, or sections.',
      });
      score -= 10;
    } else if (wordCount > BlogComposer.MAX_WORD_COUNT) {
      issues.push({
        type: 'length',
        severity: 'info',
        message: `Content is ${wordCount} words, above target range (${BlogComposer.MIN_WORD_COUNT}-${BlogComposer.MAX_WORD_COUNT} words).`,
        suggestion: 'Consider splitting into multiple posts or condensing some sections.',
      });
    }

    const outlineSections = data.outline.length;
    const contentSections = data.content.split(/\n\n#+\s/).length;
    if (contentSections < outlineSections * 0.7) {
      issues.push({
        type: 'completeness',
        severity: 'warning',
        message: 'Content may not cover all outline sections.',
        suggestion: 'Review content to ensure all outline points are addressed.',
      });
      score -= 5;
    }

    return {
      score: Math.max(0, score),
      issues,
    };
  }

  private async generateImagePrompt(
    title: string,
    content: string,
    keywords: readonly string[],
  ): Promise<string> {
    const staticPrefix = this.buildImagePromptStaticPrefix();
    const variableContent = this.buildImagePromptVariableContent(title, content, keywords);
    const prompt = staticPrefix + variableContent;

    const response = await this.callOpenAI({
      model: 'gpt-5-mini',
      reasoning: { effort: 'low' },
      text: { verbosity: 'medium' },
      maxOutputTokens: 200,
      promptCacheKey: 'flux-image-prompt-generator',
      promptCacheRetention: '24h',
    }, prompt);

    let imagePrompt = response.output_text?.trim() || '';
    imagePrompt = this.cleanImagePrompt(imagePrompt, keywords, title);

    return imagePrompt;
  }

  private calculateReadability(text: string): number {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    const syllables = words.reduce((sum, word) => sum + this.countSyllables(word), 0);

    if (sentences.length === 0 || words.length === 0) return 0;

    const avgSentenceLength = words.length / sentences.length;
    const avgSyllablesPerWord = syllables / words.length;
    const score = 206.835 - (1.015 * avgSentenceLength) - (84.6 * avgSyllablesPerWord);

    return Math.max(0, Math.min(100, score));
  }

  private countSyllables(word: string): number {
    const normalized = word.toLowerCase();
    if (normalized.length <= 3) return 1;

    let processed = normalized.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    processed = processed.replace(/^y/, '');
    const matches = processed.match(/[aeiouy]{1,2}/g);
    return matches ? matches.length : 1;
  }

  private calculateKeywordDensity(content: string, keyword: string): number {
    const words = content.toLowerCase().split(/\s+/);
    const keywordLower = keyword.toLowerCase();
    const keywordCount = words.filter((w) => w.includes(keywordLower)).length;
    return words.length > 0 ? keywordCount / words.length : 0;
  }

  private generatePersonalizationPrompt(
    experienceLevel?: string,
    audiencePersona?: string,
  ): string {
    const prompts: string[] = [];

    if (experienceLevel) {
      const levelPrompts: Record<string, readonly string[]> = {
        beginner: [
          'Use simple language and explain technical terms.',
          'Include background context and foundational concepts.',
          'Avoid jargon or assume prior knowledge.',
        ],
        intermediate: [
          'Use industry-standard terminology.',
          'Provide practical examples and actionable insights.',
          'Balance explanation with depth.',
        ],
        advanced: [
          'Use advanced terminology and concepts.',
          'Focus on nuanced insights and expert-level strategies.',
          'Assume familiarity with foundational concepts.',
        ],
      };

      const levelPrompt = levelPrompts[experienceLevel];
      if (levelPrompt) {
        prompts.push(...levelPrompt);
      }
    }

    if (audiencePersona && this.brandDNA?.targetAudiences) {
      const persona = this.brandDNA.targetAudiences.find(
        (p) => p.name === audiencePersona || p.name.toLowerCase() === audiencePersona.toLowerCase(),
      );
      if (persona) {
        prompts.push(`Target audience: ${persona.name}`);
        if (persona.psychographics?.interests?.length) {
          prompts.push(`Interests: ${persona.psychographics.interests.join(', ')}`);
        }
        if (persona.painPoints?.length) {
          prompts.push(`Address these pain points: ${persona.painPoints.join(', ')}`);
        }
      }
    }

    return prompts.join('\n');
  }

  private getLanguageName(code: string): string {
    return BlogComposer.LANGUAGE_NAMES[code] || code;
  }

  private generateTonePrompt(): string {
    const topTones = Object.entries(this.toneMatrix)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .slice(0, 3)
      .map(([tone]) => tone);

    if (topTones.length === 0) {
      return 'Write in a professional, engaging tone.';
    }

    if (topTones.length === 1) {
      return `Write in a tone that is primarily ${topTones[0]}.`;
    }

    if (topTones.length === 2) {
      return `Write in a tone that is primarily ${topTones[0]}, with elements of ${topTones[1]}.`;
    }

    return `Write in a tone that is primarily ${topTones[0]}, with elements of ${topTones[1]} and ${topTones[2]}.`;
  }

  private getStructureTemplate(structure: string): readonly string[] | null {
    return BlogComposer.STRUCTURE_TEMPLATES[structure] || null;
  }

  /**
   * Calls OpenAI API with proper error handling and fallback mechanisms
   * @throws Error if the API call fails after all retries
   */
  private async callOpenAI(config: PromptConfig, input: string): Promise<OpenAIResponse> {
    try {
      return await retry(
        () => this.openai.responses.create({
          model: config.model,
          reasoning: config.reasoning,
          text: config.text,
          input,
          max_output_tokens: config.maxOutputTokens,
          response_format: config.responseFormat,
          prompt_cache_key: config.promptCacheKey,
          prompt_cache_retention: config.promptCacheRetention,
        }),
        {
          ...BlogComposer.DEFAULT_RETRY_OPTIONS,
          onRetry: (attempt, error) => {
            // Enhanced retry logging for debugging
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (errorMsg.includes('rate limit')) {
              // Rate limit errors are expected and handled by retry logic
            }
          },
        },
      ) as OpenAIResponse;
    } catch (error) {
      // Enhanced error handling with more context
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `OpenAI API call failed for model ${config.model}: ${errorMessage}. ` +
        `Prompt cache key: ${config.promptCacheKey}`,
      );
    }
  }

  private buildOutlineStaticPrefix(template: readonly string[] | null): string {
    return `You are an expert blog content strategist specializing in SEO-optimized content architecture.

## Role
Expert content strategist with deep expertise in information architecture, user intent mapping, and SEO content planning.

## Task
Create a comprehensive blog post outline with 5-8 section headings that:
- Follows logical information hierarchy
- Addresses user search intent comprehensively
- Optimizes for featured snippets and rich results
- Maintains reader engagement throughout

## Brand Context
${JSON.stringify(this.brandDNA)}

## Structure Template
${template ? `Use this structure as a guide: ${template.join(', ')}` : 'No specific template - create optimal structure based on topic.'}

## Output Format
Return ONLY valid JSON:
{
  "outline": ["Section 1", "Section 2", ...]
}

## Constraints
- 5-8 sections minimum
- Each section should be a clear, actionable heading
- Sections must flow logically
- Include introduction and conclusion sections

Topic: `;
  }

  private buildOutlineVariableContent(
    topic: string,
    keywords: readonly string[],
    contentPreferences?: ContentOptions['contentPreferences'],
  ): string {
    let content = `${topic}
${keywords.length > 0 ? `Focus on these keywords: ${keywords.join(', ')}` : ''}`;

    if (contentPreferences?.topic_preferences && contentPreferences.topic_preferences.length > 0) {
      content += `\n\nPreferred topics to align with: ${contentPreferences.topic_preferences.join(', ')}`;
    }

    if (contentPreferences?.content_angles && contentPreferences.content_angles.length > 0) {
      content += `\n\nPreferred content angles/approaches: ${contentPreferences.content_angles.join(', ')}`;
    }

    return content;
  }

  private buildTitleStaticPrefix(language: string, languageName: string, experienceLevel?: string): string {
    const experiencePrompt = experienceLevel ? `\n## Target Audience\n${experienceLevel} level readers.` : '';
    return `You are an expert SEO content writer specializing in high-converting, search-optimized headlines.

## Role
Expert headline writer with expertise in:
- SEO title optimization
- Click-through rate maximization
- Search intent alignment
- Brand voice consistency

## Task
Generate a compelling, SEO-friendly blog post title that:
- Is exactly 60 characters or less
- Includes primary keyword naturally
- Creates curiosity and engagement
- Matches search intent
- Reflects brand voice${experiencePrompt}

## Language
${language !== 'en' ? `Write the title in ${languageName} using natural phrasing.` : 'Write in English.'}

## Output Format
Return ONLY the title text. No quotes, no explanations, no additional text.

Topic: `;
  }

  private buildTitleVariableContent(topic: string, outline: readonly string[], keywords: readonly string[]): string {
    return `${topic}
Outline: ${outline.join(', ')}
${keywords.length > 0 ? `Keywords: ${keywords.join(', ')}` : ''}`;
  }

  private buildContentStaticPrefix(
    language: string,
    languageName: string,
    tonePrompt: string,
    experienceLevel?: string,
    audiencePersona?: string,
    contentPreferences?: ContentOptions['contentPreferences'],
  ): string {
    const experiencePrompt = experienceLevel
      ? `\n## Target Audience\nWrite for ${experienceLevel} level readers. Use appropriate terminology, explanations, and depth.`
      : '';
    const personaPrompt = audiencePersona
      ? `\n## Audience Persona\nTarget: ${audiencePersona}. Tailor content, examples, and language to this specific audience.`
      : '';
    const personalizationPrompt = this.generatePersonalizationPrompt(experienceLevel, audiencePersona);

    return `You are an expert blog content writer specializing in SEO-optimized, engaging long-form content that reads naturally and authentically.

## Role
Expert content writer with deep expertise in:
- SEO content optimization
- User intent fulfillment
- Information architecture
- Brand voice consistency
- Engagement and readability
- Natural, human-like writing that avoids AI detection

## Task
Write a comprehensive, engaging blog post (1,200-1,800 words) that:
- Fulfills user search intent completely
- Naturally incorporates target keywords without keyword stuffing
- Uses proper markdown formatting (headings, paragraphs, lists)
- Maintains consistent tone and brand voice
- Provides actionable, valuable information
- Optimizes for featured snippets and rich results
- Reads like it was written by a human expert, not AI
- Uses natural sentence variety and flow
- Avoids repetitive patterns and formulaic structures
- Uses simple punctuation: commas, periods, and colons only (NO em dashes, NO en dashes)
- Varies sentence length naturally (mix short and long sentences)
- Uses contractions when appropriate for natural flow
- Includes natural transitions and conversational elements

## Writing Style Guidelines
- Write in a natural, conversational tone that feels authentic
- Avoid overly formal or stilted language
- Use active voice when possible
- Vary paragraph length for visual interest
- Include personal touches and examples where relevant
- Write as if explaining to a friend, not writing a manual
- Use simple punctuation only: commas, periods, colons, question marks, and exclamation marks
- NEVER use em dashes (—) or en dashes (–). Use commas or parentheses instead.
- Avoid repetitive sentence structures or patterns
- Make each sentence feel unique and purposeful

## Language
${language !== 'en' ? `Write the entire article in ${languageName} using natural, native-level phrasing that sounds conversational and human.` : 'Write in English with natural, conversational phrasing.'}

## Tone Guidelines
${tonePrompt}${experiencePrompt}${personaPrompt}
${personalizationPrompt ? `\n## Personalization\n${personalizationPrompt}` : ''}

## Brand Context
${JSON.stringify(this.brandDNA)}${contentPreferences?.topic_preferences && contentPreferences.topic_preferences.length > 0 ? `\n\n## Topic Preferences\nPrioritize topics related to: ${contentPreferences.topic_preferences.join(', ')}` : ''}${contentPreferences?.content_angles && contentPreferences.content_angles.length > 0 ? `\n\n## Content Angles\nUse these preferred content approaches: ${contentPreferences.content_angles.join(', ')}` : ''}

## Output Format
- Use markdown with proper heading hierarchy (# for H1, ## for H2, etc.)
- Include paragraphs, lists, and formatting as appropriate
- Ensure content flows naturally and is easy to read
- Write as a human expert would, not as an AI model

Topic: `;
  }

  private buildContentVariableContent(
    topic: string,
    outline: readonly string[],
    keywords: readonly string[],
    contentPreferences?: ContentOptions['contentPreferences'],
  ): string {
    let content = `${topic}

Follow this outline:
${outline.map((section, i) => `${i + 1}. ${section}`).join('\n')}

${keywords.length > 0 ? `Naturally incorporate these keywords: ${keywords.join(', ')}` : ''}`;

    if (contentPreferences?.topic_preferences && contentPreferences.topic_preferences.length > 0) {
      content += `\n\nAlign content with these preferred topics: ${contentPreferences.topic_preferences.join(', ')}`;
    }

    if (contentPreferences?.content_angles && contentPreferences.content_angles.length > 0) {
      content += `\n\nUse these content approaches: ${contentPreferences.content_angles.join(', ')}`;
    }

    return content;
  }

  private buildExcerptStaticPrefix(language: string, languageName: string): string {
    return `You are an expert at crafting compelling content previews optimized for engagement and SEO.

## Role
Expert excerpt writer specializing in:
- Value proposition communication
- Engagement optimization
- SEO meta description best practices
- Brand voice consistency

## Task
Generate a compelling blog post excerpt (150-160 characters) that:
- Summarizes the main value proposition clearly
- Includes a hook that encourages reading
- Is SEO-friendly and keyword-optimized
- Matches brand tone and voice
- Creates curiosity without clickbait

## Language
${language !== 'en' ? `Write the excerpt in ${languageName} using natural phrasing.` : 'Write in English.'}

## Output Format
Return ONLY the excerpt text. No quotes, no explanations, no additional text.

Title: `;
  }

  private buildExcerptVariableContent(title: string, content: string): string {
    return `${title}

Content preview: ${content.substring(0, BlogComposer.CONTENT_PREVIEW_LENGTH)}`;
  }

  private buildSEODescriptionStaticPrefix(language: string, languageName: string): string {
    return `You are an expert SEO specialist specializing in meta description optimization.

## Role
Expert SEO writer with deep expertise in:
- Search engine result page (SERP) optimization
- Click-through rate maximization
- Keyword integration
- User intent communication

## Task
Write a compelling SEO meta description (150-160 characters) that:
- Accurately summarizes the content
- Includes primary keywords naturally
- Creates compelling call-to-action
- Maximizes click-through potential
- Stays within character limits (150-160)

## Language
${language !== 'en' ? `Write the description in ${languageName} using natural, native phrasing.` : 'Write in English.'}

## Output Format
Return ONLY the meta description text. No quotes, no explanations, no additional text.

Content preview: `;
  }

  private buildSEODescriptionVariableContent(content: string, keywords: readonly string[]): string {
    return `${content.substring(0, 500)}
${keywords.length > 0 ? `Include these keywords naturally: ${keywords.join(', ')}` : ''}`;
  }

  private buildCitationStaticPrefix(): string {
    return `You are an expert fact-checker and citation specialist.

## Role
Expert content analyst specializing in:
- Fact verification
- Citation best practices
- Source credibility assessment
- Content accuracy validation

## Task
Analyze this blog post content and identify facts, statistics, and claims that should be cited.

## Citation Criteria
Identify items that:
- Are factual claims requiring verification
- Contain statistics or data
- Include quotes or references
- Make specific assertions about reality
- Require authoritative sources

## Output Format
Return ONLY valid JSON:
{
  "citations": [
    {
      "text": "the specific claim or fact",
      "source": "source name or publication",
      "type": "fact|statistic|quote|reference",
      "url": "optional source URL"
    }
  ]
}

## Constraints
- Identify 3-7 key citations
- Focus on verifiable facts and statistics
- Prioritize claims that need authoritative backing

Content: `;
  }

  private buildCitationVariableContent(content: string, topic: string): string {
    return `${content.substring(0, BlogComposer.CITATION_CONTENT_LENGTH)}

Topic: ${topic}

Identify 3-7 key facts, statistics, or claims that need citations.`;
  }

  private buildImagePromptStaticPrefix(): string {
    return `You are an expert at creating FLUX.2 image generation prompts following best practices.
Generate a professional, photorealistic image prompt for a blog post featured image.

FLUX.2 Prompt Structure (REQUIRED):
Format: Subject + Action + Style + Context

1. Subject: The main focus (what the image shows - person, object, scene)
2. Action: What the subject is doing or their pose/state
3. Style: Artistic approach (photorealistic, professional photography, specific camera/lens)
4. Context: Setting, lighting, mood, atmospheric conditions, camera details

CRITICAL RULES:
- Word order matters: Put most important elements FIRST
- Priority: Main subject → Key action → Critical style → Essential context → Secondary details
- Include specific camera/lens references for photorealism (e.g., "shot on Sony A7IV, 85mm lens, f/2.8, natural lighting")
- Be specific about what you want (FLUX.2 does NOT support negative prompts - never use "no", "without", "avoid")
- Use 30-80 words (medium length, ideal for most projects)
- Focus on describing the scene clearly and specifically
- Use natural, descriptive language

Example good prompt: "Black cat hiding behind a watermelon slice, professional studio shot, bright red and turquoise background with summer mystery vibe, shot on Canon 5D Mark IV, 24-70mm at 35mm, golden hour, shallow depth of field"

Blog post title: `;
  }

  private buildImagePromptVariableContent(title: string, content: string, keywords: readonly string[]): string {
    return `${title}

Article content summary:
${content.substring(0, BlogComposer.CONTENT_SUMMARY_LENGTH)}

Primary keywords: ${keywords.join(', ')}

Generate a FLUX.2 image prompt (30-80 words) that captures the essence of this blog post.
Follow the Subject + Action + Style + Context structure.
Include specific camera/lens details for photorealism.
Describe what you want clearly - do NOT use negative language.

Return ONLY the image prompt text, no explanation, no quotes, no formatting.`;
  }

  private cleanImagePrompt(imagePrompt: string, keywords: readonly string[], title: string): string {
    let cleaned = imagePrompt.replace(/^["']|["']$/g, '');
    cleaned = cleaned
      .replace(/\bno\s+\w+/gi, '')
      .replace(/\bwithout\s+\w+/gi, '')
      .replace(/\bavoid\s+\w+/gi, '')
      .replace(/\bdon'?t\s+\w+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned.length < BlogComposer.MIN_IMAGE_PROMPT_LENGTH) {
      const mainKeyword = keywords[0] || title.split(' ')[0];
      cleaned = `${mainKeyword}, professional studio shot, modern clean design, shot on Sony A7IV, 85mm lens, f/2.8, natural lighting, sharp focus, vibrant colors, cinematic composition, high quality professional photography style`;
    }

    return cleaned;
  }

  private createFallbackExcerpt(content: string): string {
    const firstParagraph = content.split('\n\n')[0] || content.substring(0, 200);
    const truncated = firstParagraph.substring(0, BlogComposer.MAX_EXCERPT_LENGTH - 3);
    return truncated + '...';
  }
}
