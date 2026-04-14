package cli

import (
	"fmt"
	"strings"
	"sync/atomic"
	"time"
)

// CLI provides Docker-style command line output
type CLI struct {
	quiet      bool
	phaseStart time.Time
	lastStepID string
}

// New creates a new CLI instance
func New(quiet bool) *CLI {
	return &CLI{quiet: quiet}
}

// StartPhase begins a new phase (like "Sending build context to Docker daemon")
func (c *CLI) StartPhase(name string) {
	if c.quiet {
		return
	}
	c.phaseStart = time.Now()
	fmt.Println()
	fmt.Printf("Sending context to %s...\n", name)
}

// EndPhase ends the current phase
func (c *CLI) EndPhase() time.Duration {
	duration := time.Since(c.phaseStart)
	if !c.quiet {
		fmt.Printf("Successfully completed in %s\n", formatDuration(duration))
	}
	return duration
}

// Step prints a step in Docker style: "Step N/M : description"
func (c *CLI) Step(current, total int, description string) {
	if c.quiet {
		return
	}
	c.lastStepID = fmt.Sprintf("%d/%d", current, total)
	fmt.Printf("Step %d/%d : %s\n", current, total, description)
}

// Running prints a " ---> Running in [id]" line (Docker style)
func (c *CLI) Running(message string) {
	if c.quiet {
		return
	}
	id := generateShortID()
	fmt.Printf(" ---> Running in %s\n", id)
	fmt.Printf("      %s\n", message)
}

// Info prints a " ---> message" line
func (c *CLI) Info(message string) {
	if c.quiet {
		return
	}
	fmt.Printf(" ---> %s\n", message)
}

// Success prints a success with hash (Docker-like "Removing intermediate container" + hash)
func (c *CLI) Success(message string) {
	if c.quiet {
		return
	}
	fmt.Printf(" ---> %s\n", message)
}

// Done prints completion of a step with a fake hash (Docker style)
func (c *CLI) Done() {
	if c.quiet {
		return
	}
	fmt.Printf(" ---> %s\n", generateShortID())
}

// Error prints an error message
func (c *CLI) Error(message string) {
	fmt.Printf("ERROR: %s\n", message)
}

// Warning prints a warning message
func (c *CLI) Warning(message string) {
	if c.quiet {
		return
	}
	fmt.Printf(" ---> [WARNING] %s\n", message)
}

// Progress prints a progress line that updates in place (safe for concurrent Updates)
func (c *CLI) Progress(p *Progress) {
	if c.quiet || p.Total == 0 {
		return
	}

	current := atomic.LoadInt64(&p.Current)
	percent := float64(current) / float64(p.Total) * 100
	elapsed := time.Since(p.StartTime)

	var eta time.Duration
	var rateStr string
	if current > 0 && elapsed > 0 {
		rate := float64(current) / elapsed.Seconds()
		remaining := p.Total - current
		if rate > 0 {
			eta = time.Duration(float64(remaining)/rate) * time.Second
		}
		rateStr = fmt.Sprintf("%.1f/s", rate)
	} else {
		rateStr = "--/s"
	}

	fmt.Printf("\r ---> Downloading: [%s] %d/%d %.1f%% %s eta %s    ",
		progressBar(percent), current, p.Total, percent, rateStr, formatDuration(eta))
}

// ProgressDone finishes progress output with newline
func (c *CLI) ProgressDone() {
	if c.quiet {
		return
	}
	fmt.Println()
}

// Summary prints a final summary (Docker "Successfully built" + "Successfully tagged")
func (c *CLI) Summary(title string, items map[string]string) {
	if c.quiet {
		return
	}

	fmt.Println()
	fmt.Printf("Successfully completed: %s\n", title)

	// Print items on separate lines
	for k, v := range items {
		fmt.Printf(" - %s: %s\n", k, v)
	}
}

// CacheStatus prints cache status information
func (c *CLI) CacheStatus(exists bool, entries int, sizeBytes int64, metadata map[string]string) {
	if c.quiet {
		return
	}

	fmt.Println()
	if !exists {
		fmt.Println("Cache: empty")
		return
	}

	fmt.Printf("Cache: %d entries (%s)\n", entries, formatBytes(sizeBytes))
	for k, v := range metadata {
		fmt.Printf(" - %s: %s\n", k, v)
	}
}

// progressBar creates a simple progress bar
func progressBar(percent float64) string {
	width := 20
	filled := int(float64(width) * percent / 100)
	if filled > width {
		filled = width
	}
	return strings.Repeat("=", filled) + ">" + strings.Repeat(" ", width-filled)
}

// generateShortID generates a fake Docker-style short ID
func generateShortID() string {
	// Use current time to generate a pseudo-random looking ID
	t := time.Now().UnixNano()
	chars := "0123456789abcdef"
	result := make([]byte, 12)
	for i := range result {
		result[i] = chars[(t>>(i*4))&0xf]
	}
	return string(result)
}

// formatDuration formats a duration in a human-readable way
func formatDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
	if d < time.Hour {
		m := int(d.Minutes())
		s := int(d.Seconds()) % 60
		return fmt.Sprintf("%dm%ds", m, s)
	}
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	return fmt.Sprintf("%dh%dm", h, m)
}

// formatBytes formats bytes in human-readable format
func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

// Progress tracks progress of a long-running operation.
// Current is accessed atomically so multiple goroutines can call Update concurrently.
type Progress struct {
	Total     int64
	Current   int64 // use atomic operations only
	StartTime time.Time
}

// NewProgress creates a new progress tracker
func NewProgress(total int64) *Progress {
	return &Progress{
		Total:     total,
		StartTime: time.Now(),
	}
}

// Update atomically increments current count (safe for concurrent use)
func (p *Progress) Update(delta int64) {
	atomic.AddInt64(&p.Current, delta)
}

// Set atomically sets the current progress value
func (p *Progress) Set(current int64) {
	atomic.StoreInt64(&p.Current, current)
}
