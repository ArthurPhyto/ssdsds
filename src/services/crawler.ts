import axios from 'axios';
import * as cheerio from 'cheerio';
import { CrawlJob } from '../types/crawler';
import { checkDomain } from './domainChecker';
import { useCrawlerStore } from '../store/crawlerStore';

async function validateUrl(url: string): Promise<string> {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.protocol) {
      return `https://${url}`;
    }
    return url;
  } catch (error) {
    throw new Error('Invalid URL format. Please enter a valid URL.');
  }
}

export async function startCrawl(url: string): Promise<void> {
  const jobId = Date.now().toString();
  const job: CrawlJob = {
    id: jobId,
    url,
    status: 'running',
    progress: 0,
    crawledUrls: [],
    externalLinks: [],
    expiredDomains: [],
    startTime: new Date(),
  };

  useCrawlerStore.getState().addJob(job);

  try {
    const validatedUrl = await validateUrl(url);
    const visited = new Set<string>();
    const queue = [validatedUrl];
    
    // Initial connection test
    try {
      await axios.head(validatedUrl, {
        timeout: 5000,
        headers: {
          'Accept': 'text/html',
          'User-Agent': 'Mozilla/5.0 (compatible; DomainCrawler/1.0)'
        }
      });
    } catch (error) {
      throw new Error(`Cannot connect to ${validatedUrl}. Please check if the website is accessible.`);
    }
    
    while (queue.length > 0 && useCrawlerStore.getState().activeJobs.includes(jobId)) {
      const currentUrl = queue.shift()!;
      
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      try {
        const response = await axios.get(currentUrl, {
          timeout: 10000,
          headers: {
            'Accept': 'text/html',
            'User-Agent': 'Mozilla/5.0 (compatible; DomainCrawler/1.0)'
          },
          maxRedirects: 5
        });
        
        if (response.headers['content-type']?.includes('text/html')) {
          const $ = cheerio.load(response.data);
          
          $('a').each((_, element) => {
            const href = $(element).attr('href');
            if (!href) return;

            try {
              const absoluteUrl = new URL(href, currentUrl).toString();
              const isExternal = !absoluteUrl.includes(new URL(validatedUrl).hostname);

              if (isExternal) {
                const externalDomain = new URL(absoluteUrl).hostname;
                if (!job.externalLinks.some(link => link.url === absoluteUrl)) {
                  job.externalLinks.push({
                    url: absoluteUrl,
                    statusCode: response.status,
                  });

                  checkDomain(externalDomain)
                    .then((domainCheck) => {
                      if (domainCheck.isExpired && 
                          !job.expiredDomains.some(d => d.domain === domainCheck.domain)) {
                        job.expiredDomains.push(domainCheck);
                        useCrawlerStore.getState().updateJob(jobId, {
                          ...job,
                          expiredDomains: [...job.expiredDomains]
                        });
                      }
                    })
                    .catch((error) => {
                      console.error(`Error checking domain ${externalDomain}:`, error);
                    });
                }
              } else if (!visited.has(absoluteUrl)) {
                queue.push(absoluteUrl);
              }
            } catch (urlError) {
              console.debug('Invalid URL:', href);
            }
          });
        }

        // Update crawled URLs and progress
        job.crawledUrls = [...job.crawledUrls, currentUrl];
        job.progress = (job.crawledUrls.length / (job.crawledUrls.length + queue.length)) * 100;
        
        // Real-time updates
        useCrawlerStore.getState().updateJob(jobId, {
          ...job,
          crawledUrls: [...job.crawledUrls],
          progress: job.progress
        });
      } catch (error) {
        console.error(`Error crawling ${currentUrl}:`, error);
        // Continue crawling other URLs even if one fails
        job.crawledUrls.push(`${currentUrl} (Failed: ${error.message})`);
        useCrawlerStore.getState().updateJob(jobId, {
          ...job,
          crawledUrls: [...job.crawledUrls]
        });
      }
    }

    job.status = 'completed';
    job.endTime = new Date();
    useCrawlerStore.getState().updateJob(jobId, job);
  } catch (error) {
    console.error('Crawl error:', error);
    job.status = 'error';
    job.error = error.message;
    job.endTime = new Date();
    useCrawlerStore.getState().updateJob(jobId, job);
  }
}